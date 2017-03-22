'use strict';

var Promise = require('bluebird');
var colors  = require('colors/safe');
var bhttp   = require('bhttp');
var cheerio = require('cheerio');
var common  = require('./common');

var session = bhttp.session();
var me; // backpointer for common printing methods

var currentlyCapping = [];

function removeModelFromCapList(nm) {
  for (var i = 0; i < currentlyCapping.length; i++) {
    if (currentlyCapping[i].nm == nm) {
      currentlyCapping.splice(i, 1);
      return;
    }
  }
}

function haltCapture(nm) {
  for (var i = 0; i < currentlyCapping.length; i++) {
    if (currentlyCapping[i].nm == nm) {
      process.kill(currentlyCapping[i].pid, 'SIGINT');
      removeModelFromCapList(nm);
      common.dbgMsg(me, colors.model(nm) + ' is offline, but ffmpeg is still capping. Sending SIGINT to end capture');
      return;
    }
  }
  return;
}

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

  addModelToCapList: function(nm, filename, pid) {
    var cap = {nm: nm, filename: filename, pid: pid};
    currentlyCapping.push(cap);
  },

  removeModelFromCapList: function(nm) {
    removeModelFromCapList(nm);
  },

  getNumCapsInProgress: function() {
    return currentlyCapping.length;
  },

  haltCapture: function(nm) {
    haltCapture(nm);
    return;
  },

  setupCapture: function(nm, tryingToExit) {
    for (var i = 0; i < currentlyCapping.length; i++) {
      if (currentlyCapping[i].nm == nm) {
        common.dbgMsg(me, colors.model(nm) + ' is already capturing');
        return Promise.try(function() {
          var bundle = {spawnArgs: '', filename: '', model: ''};
          return bundle;
        });
      }
    }

    if (tryingToExit) {
      common.dbgMsg(me, colors.model(nm) + ' is now online, but capture not started due to ctrl+c');
      return Promise.try(function() {
        var bundle = {spawnArgs: '', filename: '', model: ''};
        return bundle;
      });
    }

    common.msg(me, colors.model(nm) + ' is now online, captured started');

    return Promise.try(function() {
      return getStream(nm);
    }).then(function (url) {
      var filename = common.getFileName(me, nm);
      var jobs = [];
      var spawnArgs = common.getCaptureArguments(url, filename);

      var bundle = {spawnArgs: spawnArgs, filename: filename, model: nm};
      jobs.push(bundle);
      return jobs;
    })
    .catch(function(err) {
      common.errMsg(me, colors.model(nm) + ' ' + err.toString());
    });
  }
};


