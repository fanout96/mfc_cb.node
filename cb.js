'use strict';

var Promise = require('bluebird');
var colors  = require('colors/safe');
var bhttp   = require('bhttp');
var cheerio = require('cheerio');
var common  = require('./common');

var session = bhttp.session();
var me; // backpointer for common printing methods

var currentlyCapping = new Map();

function getOnlineModels() {
  return Promise.try(function() {
    return bhttp.get('http://chaturbate.com/affiliates/api/onlinerooms/?wm=mnzQo&format=json&gender=f');
  }).then(function(response) {
    var onlineModels = [];

    for (var i = 0; i < response.body.length; i++) {
      if (response.body[i].current_show == "public") {
        onlineModels.push(response.body[i].username);
      } else {
        // TODO track model status like on MFC for printouts
      }
    }

    return onlineModels;
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
    var page = cheerio.load(response.body);

    var scripts = page('script')
    .map(function(){
      return page(this).text();
    }).get().join('');

    var streamData = scripts.match(/(https\:\/\/\w+\.stream\.highwebmedia\.com\/live-edge\/[\w\-]+\/playlist\.m3u8)/i);

    if (streamData !== null) {
      url = streamData[1];
    } else {
      streamData = scripts.match(/(https\:\/\/\w+\.stream\.highwebmedia\.com\/live-edge\/amlst\:[\w\-]+\/playlist\.m3u8)/i);
      if (streamData !== null) {
        url = streamData[1];
      } else {
        common.errMsg(me, nm + ', failed to find m3u8 stream');
      }
    }

    //common.dbgMsg(me, 'url = ' + url);
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


