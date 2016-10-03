'use strict';

var Promise = require('bluebird');
var S       = require('string');
var colors  = require('colors/safe');
var mfc     = require('MFCAuto');
var bhttp   = require('bhttp');
var cheerio = require('cheerio');
var common  = require('./common');

var session = bhttp.session();
var me; // backpointer for common print methods

var filesCurrentlyCapturing = [];
var modelsCurrentlyCapturing = [];

module.exports = {
  create: function(myself) {
    me = myself;
  },

  getOnlineModels: function(page) {
    return getOnlineModels(page);
  },

  getFilesCurrentlyCapturing: function() {
    return filesCurrentlyCapturing;
  },

  setFilesCurrentlyCapturing: function(files) {
    filesCurrentlyCapturing = files;
  },

  getModelsCurrentlyCapturing: function() {
    return modelsCurrentlyCapturing;
  },

  setModelsCurrentlyCapturing: function(models) {
    modelsCurrentlyCapturing = models;
  },

  addModelToCurrentlyCapturing: function(model) {
    modelsCurrentlyCapturing.push(model);
  },

  setupCapture: function(nm, tryingToExit) {
    if (modelsCurrentlyCapturing.indexOf(nm) != -1) {
      common.dbgMsg(me, colors.model(nm) + ' is already capturing');
      return Promise.try(function() {
        var bundle = {spawnArgs: '', filename: '', model: ''};
        return bundle;
      });
    }

    if (tryingToExit) {
      common.dbgMsg(me, colors.model(nm) + ' is now online, but capture not started due to ctrl+c');
      return Promise.try(function() {
        var bundle = {spawnArgs: '', filename: '', model: ''};
        return bundle;
      });
    }

    common.msg(me, colors.model(nm) + ' is now online, starting capturing process');

    return Promise.try(function() {
      return getStreams(nm);
    }).then(function (urls) {
      var jobs = [];
      for (var i = 0; i < urls.length; i++) {
        // Note: the stream server number is appended to end of filename
        // to guarantee uniqueness when pushing and removing from  array.
        var filename = common.getFileName(me, nm) + '_' + (i+1);
        filesCurrentlyCapturing.push(filename);
        //common.dbgMsg(me, 'urls[' + i + '] = ' + urls[i]);
        var spawnArgs = common.getCaptureArguments(urls[i], filename);
        var bundle = {spawnArgs: spawnArgs, filename: filename, model: nm};
        jobs.push(bundle);
      }
      return jobs;
    })
    .catch(function(err) {
      common.errMsg(me, colors.model(nm) + ' ' + err.toString());
    });
  }
}

function getOnlineModels(page) {
  return Promise.try(function() {
    return session.get('http://www.ifriends.net/userurl_membrg2/livehosts/all-cam-girls/live-now/?pLoopPageOffset=' + page + '&p_ckname_liveBrowse=list');
  }).then(function (response) {
    var $ = cheerio.load(response.body);

    // Get an array of models found on this page
    var currentModels = $(".lb-tablerow-content")
    .map(function() {
      return $(this).find('b').text().split(',');
    })
    .get();
    //common.dbgMsg(me, 'currentModels = ' + currentModels);

    // Get the total number of pages to load
    var scripts = $('script')
    .map(function(){
      return $(this).text();
    }).get().join('');

    var pages = scripts.match(/(pager-last.*[\s\S].*appendOrReplaceURLParameter.*pLoopPageOffset.*(0|[1-9][0-9]))/i);
    if (pages == null) {
      return currentModels;
    } else {
      var totalPages = pages[pages.length-1];

      //common.dbgMsg(me, 'Fetching page ' + page + '/' + totalPages);

      // Recurse until models on all pages are loaded
      if (page < totalPages) {
        return getOnlineModels(page+1)
        .then(function(models) {
          return currentModels.concat(models);
        })
        .catch(function(err) {
          common.errMsg(me, err);
        })
      } else {
        return currentModels;
      }
    }
  })
  .catch(function(err) {
    common.dbgMsg(me, err);
  });
  return;
}

function getStreams(nm) {
  return Promise.try(function() {
    return session.get('http://www.ifriends.net/membrg/showclub_v2_custom.dll?pclub=' + nm + '&pStyle=Home');
  }).then(function (response) {
    var $ = cheerio.load(response.body);

    // Get the SessionID
    var sessionID = $('input[name="f_hid_SessionID_ExSignIn"]').attr('value');

    // TODO: Don't currently know how to automatically discover the correct
    //       stream server.  For now, ffmpeg is launched for all four servers
    //       and 3 of the jobs will die.
    var urls = [];
    for (var i = 1; i <= 4; i++) {
      var url = 'http://STREAM0' + i + '.ifriends.net:1935/LSFlashVCH/' + nm + '/' + nm + sessionID + '/playlist.m3u8';
      urls.push(url);
    }
    return urls;
  })
  .catch(function(err) {
    common.errMsg(me, colors.model(nm) + ': ' + err.toString());
  });
}

