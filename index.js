#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const fs = require('fs')
const path = require('path')
const util = require('util')

const cheerio = require('cheerio')
const decompress = require('decompress');
const program = require('commander')
const mkdirp = require('mkdirp')
const rimraf = require('rimraf')
const request = require('request').defaults({ strictSSL: true })
const temp = require('temp').track()

var channelMap = {
  esr: 'latest-esr',
  release: 'latest',
  beta: 'latest-beta',
  aurora: 'latest-mozilla-aurora',
  nightly: 'latest-trunk'
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
            /^(release|beta|esr|aurora|nightly)$/,
            'release')
    .option('-i, --install-dir <path>',
            'Destination install directory',
	          path.join(process.env.HOME, 'firefox-channels'))
    .option('-p, --platform [platform]',
            'Operating system [linux-x86_64, linux-i686, mac, win32, win64]',
            /^(linux-x86_64|linux-i686|mac|win32|win64)$/,
            'linux-x86_64')
    .option('-l, --locale [name]', 'Locale', 'en-US')
    .parse(process.argv);

  program.isLinux = program.platform.match(/^linux/i)
  program.tmpFile = temp.path({ prefix: 'fxdownload-' });
}

function parseFilename(body) {
  var fileExtension = extensionMap[program.platform]
  var $ = cheerio.load(body)

  var isReleaseBuild = isReleasePath(program.channel)

  var available = $('td a[href]').get()
      .map(
        function(elt) {
          return elt.attribs.href
        }
      ).filter(
        function(href) {
          return fileExtension.test(href)
        }
      ).sort()

  if (available.length > 1 && isReleaseBuild) {
    throw new Error('Multiple possible downloads:' + JSON.stringify(available))
  }

  if (available.length === 0) {
    throw new Error('No download available:' + JSON.stringify(available))
  }

  if (isReleaseBuild) {
    return available.pop()
  }

  // The nightly and aurora builds encode locale and platform into the
  // filename, and put them all in one directory. Find the highest numbered
  // version that matches the platform and locale.
  return available.filter(function(href) {
    return (href.match(program.platform) &&
            href.match(program.locale) &&
            !href.match('sdk'))
  }).sort().pop()
}

function ondownload() {
  var tmpDir
  if (program.isLinux) {
    tmpDir = temp.mkdirSync()
  }

  var oncomplete = function oncomplete (err) {
    if (err) throw err

    mkdirp.sync(program.installDir)
    mkdirp.sync(path.join(program.installDir, channelMap[program.channel]))

    var targetDir = path.join(program.installDir, channelMap[program.channel], program.locale)
    rimraf.sync(targetDir) // we want to overwrite with the latest available

    fs.renameSync(tmpDir, targetDir)
    fs.chmodSync(program.installDir, 0755)
    fs.chmodSync(targetDir, 0755)
    fs.unlinkSync(program.tmpFile)

    console.log('Unpacked %s successfully in %s', program.tmpFile, targetDir)
  }

  if (!program.isLinux) {
    // For mac and windows we don't unpack the download
    mkdirp.sync(program.installDir)
    fs.renameSync(program.tmpFile, program.installDir)
    console.log('Download complete. See', program.installDir)
    return
  }

  var dc = new decompress({ mode: '755'})
  dc.src(program.tmpFile)
    .dest(tmpDir)
    .use(decompress.tarbz2())
    .run(oncomplete)
}

function isReleasePath(channel) {
  return [ 'nightly', 'aurora' ].indexOf(channel) === -1
}

function run() {
  options()

  var buildsUrl = 'https://ftp.mozilla.org/pub/mozilla.org/firefox/'
  var releasePath = 'releases/%s/%s/%s/'
  var nightlyPath = 'nightly/%s/'

  var nightlyUrl = util.format(buildsUrl + nightlyPath, channelMap[program.channel])
  var releaseUrl = util.format(buildsUrl + releasePath, channelMap[program.channel],
                               program.platform, program.locale)

  var downloadUrl = isReleasePath(program.channel) ? releaseUrl  : nightlyUrl

  request.get(downloadUrl, function(err, res, body) {
    if (err) {
      return console.error(err)
    }

    if (res.statusCode !== 200) {
      return console.error('Non 200 response:', res.statusCode)
    }

    var filename = parseFilename(body)
    var url = util.format(downloadUrl + '%s', filename)
    console.log('Starting download of:', url)

    request(url)
      .on('error', function(err) {
        console.log(err)
      })
      .on('end', ondownload)
      .pipe(fs.createWriteStream(program.tmpFile))
  })
}

run()
