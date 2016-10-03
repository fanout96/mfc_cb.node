'use strict';

var fs     = require('fs');
var yaml   = require('js-yaml');
var moment = require('moment');
var S      = require('string');
var colors = require('colors/safe');

var config = yaml.safeLoad(fs.readFileSync('config.yml', 'utf8'));
var MFC;
var CB;
var IF;

module.exports = {
  getSiteName,

  getDateTime: function() {
    return getDateTime();
  },

  getFileName: function(site, nm) {
    var filename;
    if (config.includeSiteInFile) {
      filename = nm + '_' + getSiteName(site).trim().toLowerCase() + '_' + getDateTime();
    } else {
      filename = nm + '_' + getDateTime();
    }
    return filename;
  },

  setSites: function(mfcSite, cbSite, ifSite) {
    MFC = mfcSite;
    CB = cbSite;
    IF = ifSite;
  },

  initColors: function() {
    colors.setTheme({
      model: config.modelcolor, //'magenta',
      time:  config.timecolor,  //'grey',
      site:  config.sitecolor,  //'green',
      debug: config.debugcolor, //'yellow',
      error: config.errorcolor, // 'red',
    });
  },

  getCaptureArguments: function(url, filename) {
    var spawnArgs = [
      '-hide_banner',
      '-v',
      'fatal',
      '-i',
      url,
      // TODO: Some models get AV sync issues after a long time of recording.
      //       Will experiment with a per-model option to enable ffmpeg audio
      //       resampling to try and correct for sync issues.
      //'-af',
      //'aresample=async=1',
      //'-vcodec',
      '-c',
      'copy',
      config.captureDirectory + '/' + filename + '.ts'
    ];
    return spawnArgs;
  },

  msg: function(site, msg) {
    if (site === null) {
      console.log(colors.time('[' + getDateTime() + ']'), msg);
    } else {
      console.log(colors.time('[' + getDateTime() + ']'), colors.site(getSiteName(site)), msg);
    }
  },

  errMsg: function(site, msg) {
    if (site == null) {
      console.log(colors.time('[' + getDateTime() + ']'), colors.error('[ERROR]'), msg);
    } else {
      console.log(colors.time('[' + getDateTime() + ']'), colors.site(getSiteName(site)), colors.error('[ERROR]'), msg);
    }
  },

  dbgMsg: function(site, msg) {
    if (config.debug && msg) {
      if (site == null) {
        console.log(colors.time('[' + getDateTime() + ']'), colors.debug('[DEBUG]'), msg);
      } else {
        console.log(colors.time('[' + getDateTime() + ']'), colors.site(getSiteName(site)), colors.debug('[DEBUG]'), msg);
      }
    }
  }

}

function getDateTime() {
  return moment().format(config.dateFormat);
}

function getSiteName(site) {
  var name;
  switch (site) {
    case MFC: name = 'MFC'; break;
    case CB:  name = 'CB '; break;
    case IF:  name = 'IF '; break;
  }
  return name;
}

