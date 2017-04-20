'use strict';

var Promise = require('bluebird');
var colors  = require('colors/safe');
var mfc     = require('MFCAuto');
var common  = require('./common');
var fs      = require('fs');

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

function haltCapture(uid) {
  for (var i = 0; i < currentlyCapping.length; i++) {
    if (currentlyCapping[i].uid == uid) {
      process.kill(currentlyCapping[i].pid, 'SIGINT');
      removeModelFromCapList(uid);
      // TODO: Print name not uid.
      common.dbgMsg(me, colors.model(uid) + ' is offline, but ffmpeg is still capping. Sending SIGINT to end capture');
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

  //getOnlineModels: function(page) {
  getOnlineModels: function() {
    // Note: page is not used by MFC, since the MFCAuto library
    // handles the lookups for us.
    return Promise.try(function() {
      var onlineModels = mfc.Model.findModels((m) => m.bestSession.vs !== mfc.STATE.Offline);
      //common.dbgMsg(me, 'onlineModels.length = ' + onlineModels.length);
      // TODO: this grows over time even though more models aren't logging on.
      //for (var i = 0; i < onlineModels.length; i++) {
      //  common.dbgMsg(me, onlineModels[i].nm + ' is in state ' + onlineModels[i].bestSession.vs);
      //  if (onlineModels[i].bestSession.vs === mfc.STATE.Offline) {
      //    common.errMsg(me, "MFCAuto returned an offline model when requesting only online models: " + onlineModels[i].name + ' ', onlineModels[i].vs);
      //  }
      //}
      //var debug = onlineModels.toString().split(',');
      //var output = '';
      //for (var i = 0; i < debug.length; i++) {
      //  output = output + debug[i] + '\n';
      // }
      //common.writeFile('mfc_onlinemodels_' + common.getDateTime(), output);
      return onlineModels;
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
    haltCapture(uid);
    return;
  },

  checkModelState: function(uid) {
    return Promise.try(function() {
      return mfcGuest.queryUser(uid);
    }).then(function(model) {
      if (model !== undefined) {
        if (model.vs === mfc.STATE.FreeChat) {
          common.msg(me, colors.model(model.nm) + ' is in public chat!');
          modelsToCap.push(model);
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
        } else if (model.vs === mfc.STATE.Offline) {
          // Sometimes the ffmpeg process doesn't end when a model
          // logs off, but we can detect that and stop the capture
          haltCapture(uid);
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
    if (maxByteSize > 0) {
      var removeList = [];
      for (var i = 0; i < currentlyCapping.length; i++) {
        var stat = fs.statSync(captureDirectory + '/' + currentlyCapping[i].filename + '.ts');
        common.dbgMsg(me, 'Checking file size for ' + currentlyCapping[i].filename + '.  size=' + stat.size + ', maxByteSize=' + maxByteSize);
        if (stat.size > maxByteSize) {
          common.dbgMsg(me, 'Ending capture');
          process.kill(currentlyCapping[i].pid, 'SIGINT');
          removeList.push(currentlyCapping[i].uid);
        }
      }
      for (var j = 0; j < removeList.length; j++) {
        removeModelFromCapList(removeList[j]);
      }
    }
  },

  setupCapture: function(model, tryingToExit) {
    for (var i = 0; i < currentlyCapping.length; i++) {
      if (currentlyCapping[i].uid == model.uid) {
        common.dbgMsg(me, colors.model(model.nm) + ' is already capturing');
        return Promise.try(function() {
          var bundle = [];
          var item = {spawnArgs: '', filename: '', model: ''};
          bundle.push(item);
          return bundle;
        });
      }
    }

    if (tryingToExit) {
      common.dbgMsg(me, model.nm + ' capture not starting due to ctrl+c');
      return Promise.try(function() {
        var bundle = [];
        var item = {spawnArgs: '', filename: '', model: ''};
        bundle.push(item);
        return bundle;
      });
    }

    common.msg(me, colors.model(model.nm) + ', starting capture process');

    return Promise.try(function() {
      var filename = common.getFileName(me, model.nm);
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
};

