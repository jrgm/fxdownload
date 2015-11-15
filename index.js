#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const fs = require('fs')
const path = require('path')
const url = require('url')
const util = require('util')

const cheerio = require('cheerio')
const decompress = require('decompress');
const program = require('commander')
const mkdirp = require('mkdirp')
const P = require('bluebird')
const rimraf = require('rimraf')
const request = require('request').defaults({ strictSSL: true })
const temp = require('temp').track()

function channelMap(channel, file) {
  // a convenience for not naming 'latest-mozilla-aurora' as file path
  var map = {
    esr: 'latest-esr',
    release: 'latest',
    beta: 'latest-beta',
    aurora: file ? 'latest-aurora' : 'latest-mozilla-aurora',
    nightly: file ? 'latest-nightly' : 'latest-trunk'
  }
  return map[channel]
}

var extensionMap = {
  'linux-x86_64': /\.tar\.bz2$/,
  'linux-i686': /\.tar\.bz2$/,
  'mac': /\.dmg$/,
  'win32': /\.exe$/,
  'win64': /\.exe$/
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
    .parse(process.argv);
}

function isReleasePath(channel) {
  return [ 'nightly', 'aurora' ].indexOf(channel) === -1
}

function installDir(channel) {
  return path.join(program.installDir, channelMap(channel, true), program.locale)
}

function parseFilename(body, channel, locale, platform) {
  var fileExtension = extensionMap[platform]
  var $ = cheerio.load(body)

  var available = $('td a[href]').get()
      .map(function(elt) {
        return elt.attribs.href
      })
      .filter(function(href) {
        return fileExtension.test(href)
      }).sort()

  if (available.length === 0) {
    throw new Error('No download available:' + JSON.stringify(available))
  }

  var isReleaseBuild = isReleasePath(channel)

  // multiple builds are now in "latest", which breaks the point of latest. 
  // Okay, just sort them and take "largest".
  if (available.length > 1) {
    console.error('Multiple possible downloads:', JSON.stringify(available))
  }
  // The nightly and aurora builds encode locale and platform into the
  // filename, and put them all in one directory. Find the highest numbered
  // version that matches the platform and locale.
  return available.filter(function(href) {
    return (href.match(platform) &&
            href.match(locale) &&
            !href.match('sdk'))
  }).sort().pop()
}

function getDownloadUrl(channel, locale, platform) {
  var buildsUrl = 'https://ftp.mozilla.org/pub/mozilla.org/firefox/'
  var releasePath = 'releases/%s/%s/%s/'
  var nightlyPath = 'nightly/%s/'

  var nightlyUrl = util.format(buildsUrl + nightlyPath, channelMap(channel))
  var releaseUrl = util.format(buildsUrl + releasePath, channelMap(channel),
                               platform, locale)

  return isReleasePath(channel) ? releaseUrl  : nightlyUrl
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

  request.get(downloadUrl, function(err, res, body) {
    if (err) {
      return dfd.reject(err)
    }

    if (res.statusCode !== 200) {
      throw new Error('Non 200 response: ' + res.statusCode)
    }

    var filename = parseFilename(body, channel, locale, platform)
    var targetUrl = url.resolve(downloadUrl, filename)
    console.log('Starting download of:', targetUrl)

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
  var platform = program.platform

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
