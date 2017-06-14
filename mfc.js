'use strict';

var Promise = require('bluebird');
var colors  = require('colors/safe');
var mfc     = require('MFCAuto');
var common  = require('./common');

var mfcGuest;
var me; // backpointer for common print methods

var modelsToCap = [];
var modelState = new Map();
var currentlyCapping = new Map();

function haltCapture(model) {
  if (currentlyCapping.has(model.uid)) {
    var capInfo = currentlyCapping.get(model.uid);
    capInfo.captureProcess.kill('SIGINT');
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
    haltCapture(model);
  },

  checkModelState: function(uid) {
    return Promise.try(function() {
      return mfcGuest.queryUser(uid);
    }).then(function(model) {
      if (model !== undefined) {
        var isBroadcasting = 0;
        var msg = colors.model(model.nm);
        if (model.vs === mfc.STATE.FreeChat) {
          msg = msg + ' is in public chat!';
          modelsToCap.push(model);
          isBroadcasting = 1;
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
        }
        if ((modelState.has(uid) || model.vs !== mfc.STATE.Offline) && model.vs !== modelState.get(uid)) {
          common.msg(me, msg);
        }
        modelState.set(uid, model.vs);
        if (currentlyCapping.has(model.uid) && isBroadcasting === 0) {
          // Sometimes the ffmpeg process doesn't end when a model
          // stops broadcasting, so terminate it.
          common.dbgMsg(me, colors.model(model.nm) + ' is not broadcasting, but ffmpeg is still active. Terminating with SIGINT.');
          haltCapture(model);
        }
      }
      return true;
    })
    .catch(function(err) {
      common.errMsg(me, err.toString());
    });
  },

  addModelToCapList: function(model, filename, captureProcess) {
    if (currentlyCapping.has(model.uid)) {
      common.errMsg(me, colors.model(model.nm) + ' is already capturing, terminating current capture, if this happens please report a bug on github with full debug logs');
      haltCapture(model);
    }
    currentlyCapping.set(model.uid, {nm: model.nm, filename: filename, captureProcess: captureProcess});
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

      return {spawnArgs: spawnArgs, filename: filename, model: model};
    })
    .catch(function(err) {
      common.errMsg(me, colors.model(model.nm) + ': ' + err.toString());
    });
  }
};

