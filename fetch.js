#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const fs = require('fs')
const path = require('path')
const url = require('url')
const util = require('util')

const P = require('bluebird')
const decompress = require('decompress')
const mkdirp = require('mkdirp')
const program = require('commander')
const request = require('request').defaults({ strictSSL: true })
const rimraf = require('rimraf')
const temp = require('temp').track()

function channelMap(channel, file) {
  var map = {
    esr:     file ? 'latest-esr'     : 'firefox-esr-latest',
    release: file ? 'latest'         : 'firefox-latest',
    beta:    file ? 'latest-beta'    : 'firefox-beta-latest',
    aurora:  file ? 'latest-aurora'  : 'firefox-aurora-latest',
    nightly: file ? 'latest-nightly' : 'firefox-nightly-latest'
  }
  return map[channel] || 'firefox-' + channel;
}

function platformMap(platform) {
  var map = {
    'linux-x86_64': 'linux64',
    'linux-i686': 'linux',
    'mac': 'osx',
    'win32': 'win',
    'win64': 'win64'
  }
  return map[platform]
}

function options() {
  program
    .option('-c, --channel [channel]',
            'Release channel [release, beta, esr, aurora, nightly]',
            function(list) {
              return list.split(/,/)
            })
    .option('-i, --install-dir <path>',
            'Destination install directory',
            path.join(process.env.HOME, 'firefox-channels'))
    .option('-p, --platform [platform]',
            'Operating system [linux-x86_64, linux-i686, mac, win32, win64]',
            /^(linux-x86_64|linux-i686|mac|win32|win64)$/,
            'linux-x86_64')
    .option('-l, --locale [name]', 'Locale', 'en-US')
    .parse(process.argv)
}

function installDir(channel) {
  return path.join(program.installDir, channelMap(channel, true), program.locale)
}

function getDownloadUrl(channel, locale, platform) {
  return  util.format('https://download.mozilla.org/?product=%s&os=%s&lang=%s',
                      channelMap(channel), platform, locale)
}

function start(channel, locale, platform) {
  var dfd = P.defer()

  var downloadUrl = getDownloadUrl(channel, locale, platform)

  function ondownload(src, filename) {
    var installdir = installDir(channel)
    rimraf.sync(installdir) // we want to overwrite with the latest available
    mkdirp.sync(installdir)

    if (!program.platform.match(/^linux/i)) {
      // For mac and windows we don't unpack the download
      fs.renameSync(src, path.join(installdir, filename))
      console.log('Download complete. See %s', installdir)
      return dfd.resolve()
    }

    var dc = new decompress({ mode: '755'})
    dc.src(src)
      .dest(installdir)
      .use(decompress.tarbz2())
      .run(function(err) {
        if (err) {
          return dfd.reject(err)
        }
        console.log('Unpacked successfully in %s', installdir)
        return dfd.resolve()
      })
  }

  console.log('Looking for redirect from:', downloadUrl)
  var options = { uri: downloadUrl, followRedirect: false }
  request.get(options, function(err, res, body) {
    if (err) {
      return dfd.reject(err)
    }

    if (res.statusCode !== 302) {
      throw new Error('Non 302 response: ' + res.statusCode + ' ' + downloadUrl)
    }

    var targetUrl = res.headers.location
    if (!targetUrl) {
      throw new Error('Could not find target url: ' + res.statusCode + ' ' +
                      JSON.stringify(res.headers.sort(), null, 2))
    }
    console.log('Starting download of:', targetUrl)
    var filename = path.basename(url.parse(targetUrl).pathname)

    var writeStream = temp.createWriteStream('fxdownload-')
    request(targetUrl)
      .on('error', function(err) {
        return dfd.reject(err)
      })
      .on('end', ondownload.bind(null, writeStream.path, filename))
      .pipe(writeStream)
  })

  return dfd.promise
}

function run() {
  options()

  var downloads = []
  var locale = program.locale
  var platform = platformMap(program.platform)

  program.channel.forEach(function(channel) {
    downloads.push(start(channel, locale, platform))
  })

  P.all(downloads)
    .then(function() {
      console.log('All done.')
    })
    .catch(function(err) {
      console.error(err)
    })
}

run()
