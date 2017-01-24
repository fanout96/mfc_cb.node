'use strict';

var fs     = require('fs');
var yaml   = require('js-yaml');
var moment = require('moment');
var colors = require('colors/safe');

var config = yaml.safeLoad(fs.readFileSync('config.yml', 'utf8'));
var MFC;
var CB;

function getDateTime() {
  return moment().format(config.dateFormat);
}

function getSiteName(site) {
  var name;
  switch (site) {
    case MFC: name = 'MFC'; break;
    case CB:  name = 'CB '; break;
  }
  return name;
}

module.exports = {
  getSiteName,

  getDateTime: function() {
    return getDateTime();
  },

  writeFile: function(filename, msg) {
    fs.writeFile('/tmp/' + filename, msg, function(err) {
      if (err) {
          return console.log(err);
      }
    });
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

  setSites: function(mfcSite, cbSite) {
    MFC = mfcSite;
    CB = cbSite;
  },

  initColors: function() {
    colors.setTheme({
      model: config.modelcolor,
      time:  config.timecolor,
      site:  config.sitecolor,
      debug: config.debugcolor,
      error: config.errorcolor,
    });
  },

  getCaptureArguments: function(url, filename) {
    var spawnArgs = [
      '-hide_banner',
      '-v',
      'fatal',
      '-i',
      url,
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
    if (site === null) {
      console.log(colors.time('[' + getDateTime() + ']'), colors.error('[ERROR]'), msg);
    } else {
      console.log(colors.time('[' + getDateTime() + ']'), colors.site(getSiteName(site)), colors.error('[ERROR]'), msg);
    }
  },

  dbgMsg: function(site, msg) {
    if (config.debug && msg) {
      if (site === null) {
        console.log(colors.time('[' + getDateTime() + ']'), colors.debug('[DEBUG]'), msg);
      } else {
        console.log(colors.time('[' + getDateTime() + ']'), colors.site(getSiteName(site)), colors.debug('[DEBUG]'), msg);
      }
    }
  }
};

