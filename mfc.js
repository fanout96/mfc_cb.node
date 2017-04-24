'use strict';

var Promise = require('bluebird');
var colors  = require('colors/safe');
var mfc     = require('MFCAuto');
var common  = require('./common');

var mfcGuest;
var modelsToCap = [];
var modelState = new Map();
var currentlyCapping = new Map();
var me; // backpointer for common print methods

function haltCapture(model, offline) {
  if (currentlyCapping.has(model.uid)) {
    var capInfo = currentlyCapping.get(model.uid);
    process.kill(capInfo.pid, 'SIGINT');
    if (offline === 1) {
      common.dbgMsg(me, colors.model(model.uid) + ' is offline, but ffmpeg is still capping. Sending SIGINT to end capture');
    }
  }
}

module.exports = {

  create: function(myself) {
    mfcGuest = new mfc.Client();
    me = myself;
  },

  connect: function() {
    return Promise.try(function() {
      return mfcGuest.connectAndWaitForModels();
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

  haltCapture: function(model) {
    haltCapture(model, 0);
    return;
  },

  checkModelState: function(uid) {
    return Promise.try(function() {
      return mfcGuest.queryUser(uid);
    }).then(function(model) {
      if (model !== undefined) {
        var msg = colors.model(model.nm);
        if (model.vs === mfc.STATE.FreeChat) {
          msg = msg + ' is in public chat!';
          modelsToCap.push(model);
        } else if (model.vs === mfc.STATE.GroupShow) {
          msg = msg + ' is in a group show';
        } else if (model.vs === mfc.STATE.Private) {
          if (model.truepvt === 1) {
            msg = msg + ' is in a true private show.';
          } else {
            msg = msg + ' is in a private show.';
          }
        } else if (model.vs === mfc.STATE.Away) {
          msg = msg + ' is away.';
        } else if (model.vs === mfc.STATE.Online) {
          msg = msg + colors.model('\'s') + ' cam is off.';
        } else if (model.vs === mfc.STATE.Offline) {
          msg = msg + ' has logged off.';
          // Sometimes the ffmpeg process doesn't end when a model
          // logs off, but we can detect that and stop the capture
          haltCapture(uid, 1);
        }
        if ((modelState.has(uid) || model.vs !== mfc.STATE.Offline) && model.vs !== modelState.get(uid)) {
          common.msg(me, msg);
        }
        modelState.set(uid, model.vs);
      }
      return true;
    })
    .catch(function(err) {
      common.errMsg(me, err.toString());
    });
  },

  addModelToCapList: function(model, filename, pid) {
    currentlyCapping.set(model.uid, {nm: model.nm, filename: filename, pid: pid});
  },

  removeModelFromCapList: function(model) {
    currentlyCapping.delete(model.uid);
  },

  getNumCapsInProgress: function() {
    return currentlyCapping.size;
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
      common.dbgMsg(me, colors.model(model.nm) + ' capture not starting due to ctrl+c');
      return Promise.try(function() {
        return {spawnArgs: '', filename: '', model: ''};
      });
    }

    return Promise.try(function() {
      var filename = common.getFileName(me, model.nm);
      var spawnArgs = common.getCaptureArguments('http://video' + (model.u.camserv - 500) + '.myfreecams.com:1935/NxServer/ngrp:mfc_' + (100000000 + model.uid) + '.f4v_mobile/playlist.m3u8', filename);

      common.msg(me, colors.model(model.nm) + ' recording started (' + filename + '.ts)');

      return {spawnArgs: spawnArgs, filename: filename, model: model};
    })
    .catch(function(err) {
      common.errMsg(me, colors.model(model.nm) + ': ' + err.toString());
    });
  }
};

