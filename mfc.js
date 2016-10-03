'use strict';

var Promise = require('bluebird');
var S       = require('string');
var colors  = require('colors/safe');
var mfc     = require('MFCAuto');
var common  = require('./common');

var mfcGuest;
var myModels = [];
var filesCurrentlyCapturing = [];
var modelsCurrentlyCapturing = [];
var me; // backpointer for common print methods

module.exports = {
  mfcGuest,

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

  getOnlineModels: function(page) {
    // Note: page is not used by MFC, since the MFCAuto library
    // handles the lookups for us.
    return Promise.try(function() {
      return mfc.Model.findModels((m) => true);
    })
    .catch(function(err) {
      common.errMsg(me, err.toString());
    });
  },

  queryUser: function(nm) {
    return mfcGuest.queryUser(nm);
  },

  getMyModels: function() {
    return myModels;
  },

  clearMyModels: function() {
    myModels = [];
  },

  checkModelState: function(uid) {
    return Promise.try(function() {
      return mfcGuest.queryUser(uid);
    }).then(function(model) {
      if (model !== undefined) {
        if (model.vs === mfc.STATE.FreeChat) {
          common.msg(me, colors.model(model.nm) + ' is in public chat!');
          myModels.push(model);
        } else if (model.vs === mfc.STATE.GroupShow) {
          common.msg(me, colors.model(model.nm) + ' is in a group show');
        } else if (model.vs === mfc.STATE.Private) {
          if (model.truepvt === 1) {
            common.msg(me, colors.model(model.nm) + ' is in a true private show.');
          } else {
            common.msg(me, colors.model(model.nm) + ' is in a private show.');
          }
        } else if (model.vs === mfc.STATE.Away) {
          common.msg(me, colors.model(model.nm) + ' is away');
        } else if (model.vs === mfc.STATE.Online) {
          common.msg(me, colors.model(model.nm + '\'s') + ' cam is off.');
        }
      }
      return true;
    })
    .catch(function(err) {
      common.errMsg(me, err.toString());
    });
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

  setupCapture: function(model, tryingToExit) {
    if (modelsCurrentlyCapturing.indexOf(model.uid) != -1) {
      common.dbgMsg(me, colors.model(model.nm) + ' is already capturing');
      return Promise.try(function() {
        var bundle = {spawnArgs: '', filename: '', model: ''};
        return bundle;
      });
    }

    if (tryingToExit) {
      common.dbgMsg(me, model.nm + ' capture not starting due to ctrl+c');
      return Promise.try(function() {
        var bundle = {spawnArgs: '', filename: '', model: ''};
        return bundle;
      });
    }

    common.msg(me, colors.model(model.nm) + ', starting capture process');

    return Promise.try(function() {
      var filename = common.getFileName(me, model.nm);
      filesCurrentlyCapturing.push(filename);
      var jobs = [];
      var spawnArgs = common.getCaptureArguments('http://video' + (model.u.camserv - 500) + '.myfreecams.com:1935/NxServer/ngrp:mfc_' + (100000000 + model.uid) + '.f4v_mobile/playlist.m3u8', filename);

      var bundle = {spawnArgs: spawnArgs, filename: filename, model: model};
      jobs.push(bundle);
      return jobs;
    })
    .catch(function(err) {
      common.errMsg(me, colors.model(model.nm) + ': ' + err.toString());
    });
  }
}

