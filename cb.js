'use strict';

var Promise = require('bluebird');
var colors  = require('colors/safe');
var bhttp   = require('bhttp');
var cheerio = require('cheerio');
var common  = require('./common');

var session = bhttp.session();
var me; // backpointer for common printing methods

var currentlyCapping = new Map();

function getOnlineModels(page) {
  return Promise.try(function() {
    return session.get('https://chaturbate.com/?page=' + page);
  }).then(function(response) {

    var $ = cheerio.load(response.body);

    // Get an array of models found on this page
    var currentModels = $('#main div.content ul.list').children('li')
    .filter(function(){
        return $(this).find('div.details ul.sub-info li.cams').text() != 'offline';
    })
    .map(function(){
        return $(this).find('div.title a').text().trim().split(',');
    })
    .get();

    // Find the total number of model pages
    var pages = $('#main div.content ul.paging').children('li')
    .filter(function() {
      return $(this).find('a').text().trim() != 'next';
    })
    .map(function() {
      return $(this).find('a').text().trim();
    })
    .get();
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
      });
    } else {
      return currentModels;
    }
  })
  .catch(function(err) {
    common.errMsg(me, err.toString());
  });
}

function getStream(nm) {
  return Promise.try(function() {
    return session.get('https://chaturbate.com/' + nm + '/');
  }).then(function (response) {
    var url = '';
    var $ = cheerio.load(response.body);

    var scripts = $('script')
    .map(function(){
      return $(this).text();
    }).get().join('');

    var streamData = scripts.match(/(https\:\/\/\w+\.stream\.highwebmedia\.com\/live-edge\/[\w\-]+\/playlist\.m3u8)/i);

    if (streamData !== null) {
      url = streamData[1];
      //common.dbgMsg(me, 'url = ' + url);
    } else {
      common.errMsg(me, nm + ' is offline');
    }

    return url;
  })
  .catch(function(err) {
    common.errMsg(me, colors.model(nm) + ': ' + err.toString());
  });
}

module.exports = {
  create: function(myself) {
    me = myself;
  },

  getOnlineModels: function() {
    return getOnlineModels(1);
  },

  addModelToCapList: function(model, filename, captureProcess) {
    currentlyCapping.set(model.uid, {nm: model.nm, filename: filename, captureProcess: captureProcess});
  },

  removeModelFromCapList: function(model) {
    currentlyCapping.delete(model.uid);
  },

  getNumCapsInProgress: function() {
    return currentlyCapping.size;
  },

  haltCapture: function(model) {
    if (currentlyCapping.has(model.uid)) {
      var capInfo = currentlyCapping.get(model.uid);
      capInfo.captureProcess.kill('SIGINT');
    }
  },

  checkFileSize: function(captureDirectory, maxByteSize) {
    common.checkFileSize(me, captureDirectory, maxByteSize, currentlyCapping);
  },

  setupCapture: function(model, tryingToExit) {
    if (currentlyCapping.has(model.uid)) {
      common.dbgMsg(me, colors.model(model.nm) + ' is already capturing');
      return Promise.try(function() {
        return {spawnArgs: '', filename: '', model: ''};
      });
    }

    if (tryingToExit) {
      common.dbgMsg(me, colors.model(model.nm) + ' is now online, but capture not started due to ctrl+c');
      return Promise.try(function() {
        return {spawnArgs: '', filename: '', model: ''};
      });
    }

    return Promise.try(function() {
      return getStream(model.nm);
    }).then(function (url) {
      var filename = common.getFileName(me, model.nm);
      var spawnArgs = common.getCaptureArguments(url, filename);

      return {spawnArgs: spawnArgs, filename: filename, model: model};
    })
    .catch(function(err) {
      common.errMsg(me, colors.model(model.nm) + ' ' + err.toString());
    });
  }
};


