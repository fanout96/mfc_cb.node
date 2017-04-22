'use strict';

var Promise = require('bluebird');
var colors  = require('colors/safe');
var mfc     = require('MFCAuto');
var common  = require('./common');

var mfcGuest;
var modelsToCap = [];
var currentlyCapping = [];
var me; // backpointer for common print methods

function removeModelFromCapList(uid) {
  for (var i = 0; i < currentlyCapping.length; i++) {
    if (currentlyCapping[i].uid == uid) {
      currentlyCapping.splice(i, 1);
      return;
    }
  }
  return;
}

function haltCapture(uid, offline) {
  for (var i = 0; i < currentlyCapping.length; i++) {
    if (currentlyCapping[i].uid == uid) {
      process.kill(currentlyCapping[i].pid, 'SIGINT');
      if (offline === 1) {
        common.dbgMsg(me, colors.model(uid) + ' is offline, but ffmpeg is still capping. Sending SIGINT to end capture');
      }
      return;
    }
  }
  return;
}

module.exports = {

  create: function(myself) {
    mfcGuest = new mfc.Client();
    me = myself;
  },

  connect: function() {
    return Promise.try(function() {
      return mfcGuest.connect(true);
    }).catch(function(err) {
      return err;
    });
  },

  disconnect: function() {
    mfcGuest.disconnect();
  },

  getOnlineModels: function() {
    return Promise.try(function() {
      return mfc.Model.findModels((m) => m.bestSession.vs !== mfc.STATE.Offline);
    })
    .catch(function(err) {
      common.errMsg(me, err.toString());
    });
  },

  queryUser: function(nm) {
    return mfcGuest.queryUser(nm);
  },

  getModelsToCap: function() {
    return modelsToCap;
  },

  clearMyModels: function() {
    modelsToCap = [];
  },

  haltCapture: function(uid) {
    haltCapture(uid, 0);
    return;
  },

  checkModelState: function(uid) {
    return Promise.try(function() {
      return mfcGuest.queryUser(uid);
    }).then(function(model) {
      if (model !== undefined) {
        if (model.vs === mfc.STATE.FreeChat) {
          common.dbgMsg(me, colors.model(model.nm) + ' is in public chat!');
          modelsToCap.push(model);
        } else if (model.vs === mfc.STATE.GroupShow) {
          common.dbgMsg(me, colors.model(model.nm) + ' is in a group show');
        } else if (model.vs === mfc.STATE.Private) {
          if (model.truepvt === 1) {
            common.dbgMsg(me, colors.model(model.nm) + ' is in a true private show.');
          } else {
            common.dbgMsg(me, colors.model(model.nm) + ' is in a private show.');
          }
        } else if (model.vs === mfc.STATE.Away) {
          common.dbgMsg(me, colors.model(model.nm) + ' is away.');
        } else if (model.vs === mfc.STATE.Online) {
          common.dbgMsg(me, colors.model(model.nm + '\'s') + ' cam is off.');
        } else if (model.vs === mfc.STATE.Offline) {
          // Sometimes the ffmpeg process doesn't end when a model
          // logs off, but we can detect that and stop the capture
          haltCapture(uid, 1);
        }
      }
      return true;
    })
    .catch(function(err) {
      common.errMsg(me, err.toString());
    });
  },

  addModelToCapList: function(uid, filename, pid) {
    var cap = {uid: uid, filename: filename, pid: pid};
    currentlyCapping.push(cap);
  },

  removeModelFromCapList: function(uid) {
    removeModelFromCapList(uid);
  },

  getNumCapsInProgress: function() {
    return currentlyCapping.length;
  },

  checkFileSize: function(captureDirectory, maxByteSize) {
    common.checkFileSize(me, captureDirectory, maxByteSize, currentlyCapping);
  },

  setupCapture: function(model, tryingToExit) {
    for (var i = 0; i < currentlyCapping.length; i++) {
      if (currentlyCapping[i].uid == model.uid) {
        common.dbgMsg(me, colors.model(model.nm) + ' is already capturing');
        return Promise.try(function() {
          return {spawnArgs: '', filename: '', model: ''};
        });
      }
    }

    if (tryingToExit) {
      common.dbgMsg(me, model.nm + ' capture not starting due to ctrl+c');
      return Promise.try(function() {
        return {spawnArgs: '', filename: '', model: ''};
      });
    }

    return Promise.try(function() {
      var filename = common.getFileName(me, model.nm);
      var spawnArgs = common.getCaptureArguments('http://video' + (model.u.camserv - 500) + '.myfreecams.com:1935/NxServer/ngrp:mfc_' + (100000000 + model.uid) + '.f4v_mobile/playlist.m3u8', filename);

      common.msg(me, colors.model(model.nm) + ', starting ffmpeg capture to ' + filename + '.ts');

      return {spawnArgs: spawnArgs, filename: filename, model: model};
    })
    .catch(function(err) {
      common.errMsg(me, colors.model(model.nm) + ': ' + err.toString());
    });
  }
};

