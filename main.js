'use strict';
require('events').EventEmitter.prototype._maxListeners = 100;

// Load 3rd Party Libraries
var Promise      = require('bluebird');
var fs           = require('fs');
var mv           = require('mv');
var yaml         = require('js-yaml');
var mkdirp       = require('mkdirp');
var colors       = require('colors/safe');
var _            = require('underscore');
var childProcess = require('child_process');
var path         = require('path');

// Load local libraries
var common       = require('./common');
var MFC          = require('./mfc');
var CB           = require('./cb');

var SITES        = [MFC, CB];
var semaphore    = 0; // Counting semaphore
var tryingToExit = 0;
var config       = yaml.safeLoad(fs.readFileSync('config.yml', 'utf8'));

config.captureDirectory  = path.resolve(config.captureDirectory);
config.completeDirectory = path.resolve(config.completeDirectory);

common.setSites(MFC, CB);
common.initColors();

// time in milliseconds
function sleep(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

// Processes updates.yml and adds or removes models from config.yml
function processUpdates(site) {
  var stats = fs.statSync('updates.yml');

  var includeModels = [];
  var excludeModels = [];

  if (stats.isFile()) {
    var updates = yaml.safeLoad(fs.readFileSync('updates.yml', 'utf8'));

    switch (site) {
      case MFC:
        if (!updates.includeMfcModels) {
          updates.includeMfcModels = [];
        } else if (updates.includeMfcModels.length > 0) {
          common.msg(site, updates.includeMfcModels.length + ' model(s) to include');
          includeModels = updates.includeMfcModels;
          updates.includeMfcModels = [];
        }

        if (!updates.excludeMfcModels) {
          updates.excludeMfcModels = [];
        } else if (updates.excludeMfcModels.length > 0) {
          common.msg(site, updates.excludeMfcModels.length + ' model(s) to exclude');
          excludeModels = updates.excludeMfcModels;
          updates.excludeMfcModels = [];
        }
        break;

      case CB:
        if (!updates.includeCbModels) {
          updates.includeCbModels = [];
        } else if (updates.includeCbModels.length > 0) {
          common.msg(CB, updates.includeCbModels.length + ' model(s) to include');
          includeModels = updates.includeCbModels;
          updates.includeCbModels = [];
        }

        if (!updates.excludeCbModels) {
          updates.excludeCbModels = [];
        } else if (updates.excludeCbModels.length > 0) {
          common.msg(site, updates.excludeCbModels.length + ' model(s) to exclude');
          excludeModels = updates.excludeCbModels;
          updates.excludeCbModels = [];
        }
        break;
    }

    // if there were some updates, then rewrite updates.yml
    if (includeModels.length > 0 || excludeModels.length > 0) {
      fs.writeFileSync('updates.yml', yaml.safeDump(updates), 'utf8');
    }
  }

  return {includeModels: includeModels, excludeModels: excludeModels, dirty: false};
}

function addModel(site, model) {
  var index;

  switch (site) {
    case MFC: index = config.mfcmodels.indexOf(model.uid); break;
    case CB:  index = config.cbmodels.indexOf(model.uid);  break;
  }

  if (index === -1) {
    common.msg(site, colors.model(model.nm) + colors.italic(' added') + ' to capture list');

    switch (site) {
      case MFC: config.mfcmodels.push(model.uid); break;
      case CB:  config.cbmodels.push(model.uid);  break;
    }

    return true;
  } else {
    common.msg(site, colors.model(model.nm) + ' is already in the capture list');
  }

  return false;
}

function addModels(site, bundle) {
  var i;

  switch (site) {
    case MFC:
      // Fetch the UID of new models to add to capture list.
      // The model does not have to be online for this.
      var queries = [];
      for (i = 0; i < bundle.includeModels.length; i++) {
        var query = MFC.queryUser(bundle.includeModels[i]).then((model) => {
          if (typeof model !== 'undefined') {
            bundle.dirty |= addModel(site, model);
          }
        });
        queries.push(query);
      }

      return Promise.all(queries).then(function() {
        return bundle;
      });

    case CB:
      for (i = 0; i < bundle.includeModels.length; i++) {
        bundle.dirty |= addModel(site, {nm: bundle.includeModels[i], uid: bundle.includeModels[i]});
      }
      return bundle;
  }
  return;
}

function removeModel(site, model) {

  common.msg(site, colors.model(model.nm) + colors.italic(' removed') + ' from capture list.');
  site.haltCapture(model);

  switch (site) {
    case MFC: config.mfcmodels = _.without(config.mfcmodels, model.uid); break;
    case CB:  config.cbmodels  = _.without(config.cbmodels,  model.uid); break;
  }

  return true;
}

function removeModels(site, bundle) {
  var i;
  switch (site) {
    case MFC:
      // Fetch the UID of current models to be excluded from capture list.
      // The model does not have to be online for this.
      var queries = [];
      for (i = 0; i < bundle.excludeModels.length; i++) {
        var query = MFC.queryUser(bundle.excludeModels[i]).then((model) => {
          if (typeof model !== 'undefined') {
            bundle.dirty |= removeModel(site, model);
          }
        });
        queries.push(query);
      }

      return Promise.all(queries).then(function() {
        return bundle.dirty;
      });

    case CB:
      for (i = 0; i < bundle.excludeModels.length; i++) {
        var nm = bundle.excludeModels[i];
        var index = config.cbmodels.indexOf(nm);
        if (index !== -1) {
          bundle.dirty |= removeModel(site, {nm: nm, uid: nm});
        }
      }
      return bundle.dirty;
  }
  return;
}

function writeConfig(site, dirty) {
  if (dirty) {
    common.dbgMsg(site, 'Rewriting config.yml');
    fs.writeFileSync('config.yml', yaml.safeDump(config), 'utf8');
  }
}

function getModelsToCap(site) {
  switch (site) {
    case MFC:
      site.clearMyModels();
      return Promise.all(config.mfcmodels.map(MFC.checkModelState))
      .then(function() {
        return site.getModelsToCap();
      })
      .catch(function(err) {
        common.errMsg(site, err.toString());
      });

    case CB:
      return Promise.all(site.getOnlineModels())
      .then(function(onlineModels) {
        var modelsToCap = [];
        _.each(config.cbmodels, function(nm) {
          var modelIndex = onlineModels.indexOf(nm);
          if (modelIndex !== -1) {
            modelsToCap.push({nm: nm, uid: nm});
          }
        });
        return modelsToCap;
      });
  }
}

function postProcess(site, filename, model) {
  var modelDir = config.completeDirectory;

  if (config.modelSubdir) {
    modelDir = modelDir + '/' + model.nm;
    mkdirp.sync(modelDir);
  }

  if (config.autoConvertType !== 'mp4' && config.autoConvertType !== 'mkv') {
    common.dbgMsg(site, colors.model(model.nm) + ' recording moved (' + config.captureDirectory + '/' + filename + '.ts to ' + modelDir + '/' + filename + '.ts)');
    mv(config.captureDirectory + '/' + filename + '.ts', modelDir + '/' + filename + '.ts', function(err) {
      if (err) {
        common.errMsg(site, colors.site(filename) + ': ' + err.toString());
      }
    });
    return;
  }

  var mySpawnArguments;
  if (config.autoConvertType == 'mp4') {
    mySpawnArguments = [
      '-hide_banner',
      '-v',
      'fatal',
      '-i',
      config.captureDirectory + '/' + filename + '.ts',
      '-c',
      'copy',
      '-vsync',
      '2',
      '-r',
      '60',
      '-b:v',
      '500k',
      '-bsf:a',
      'aac_adtstoasc',
      '-copyts',
      modelDir + '/' + filename + '.' + config.autoConvertType
    ];
  } else if (config.autoConvertType == 'mkv') {
    mySpawnArguments = [
      '-hide_banner',
      '-v',
      'fatal',
      '-i',
      config.captureDirectory + '/' + filename + '.ts',
      '-c',
      'copy',
      '-vsync',
      '2',
      '-r',
      '60',
      '-b:v',
      '500k',
      '-copyts',
      modelDir + '/' + filename + '.' + config.autoConvertType
    ];
  }

  semaphore++;

  common.msg(site, colors.model(model.nm) + ' converting to ' + filename + '.' + config.autoConvertType);

  var myCompleteProcess = childProcess.spawn('ffmpeg', mySpawnArguments);

  myCompleteProcess.on('close', function() {
    if (!config.keepTsFile) {
      fs.unlinkSync(config.captureDirectory + '/' + filename + '.ts');
    }
    semaphore--; // release semaphore only when ffmpeg process has ended
  });

  myCompleteProcess.on('error', function(err) {
    common.errMsg(site, err);
  });
}

function startCapture(site, spawnArgs, filename, model) {

  var captureProcess = childProcess.spawn('ffmpeg', spawnArgs);

  captureProcess.on('close', function() {
    if (tryingToExit) {
      common.msg(site, colors.model(model.nm) + ' capture interrupted');
    }

    site.removeModelFromCapList(model);

    fs.stat(config.captureDirectory + '/' + filename + '.ts', function(err, stats) {
      if (err) {
        if (err.code == 'ENOENT') {
          common.errMsg(site, colors.model(model.nm) + ', ' + filename + '.ts not found in capturing directory, cannot convert to ' + config.autoConvertType);
        } else {
          common.errMsg(site, colors.model(model.nm) + ': ' + err.toString());
        }
      } else if (stats.size <= config.minByteSize) {
        common.msg(site, colors.model(model.nm) + ' recording automatically deleted (size=' + stats.size + ' < minSizeBytes=' + config.minByteSize + ')');
        fs.unlinkSync(config.captureDirectory + '/' + filename + '.ts');
      } else {
        postProcess(site, filename, model);
      }
    });
  });

  if (!!captureProcess.pid) {
    common.msg(site, colors.model(model.nm) + ' recording started (' + filename + '.ts)');
    site.addModelToCapList(model, filename, captureProcess);
  }
}

function mainSiteLoop(site) {

  Promise.try(function() {
    site.checkFileSize(config.captureDirectory, config.maxByteSize);
  })
  .then(function() {
    return processUpdates(site);
  })
  .then(function(bundle) {
    return addModels(site, bundle);
  })
  .then(function(bundle) {
    return removeModels(site, bundle);
  })
  .then(function(dirty) {
    return writeConfig(site, dirty);
  })
  .then(function() {
    return getModelsToCap(site);
  })
  .then(function(modelsToCap) {
    if (modelsToCap !== null) {
      if (modelsToCap.length > 0) {
        common.dbgMsg(site, modelsToCap.length + ' model(s) to capture');
        var caps = [];
        for (var i = 0; i < modelsToCap.length; i++) {
          var cap = site.setupCapture(modelsToCap[i], tryingToExit).then(function(bundle) {
            if (bundle.spawnArgs !== '') {
              startCapture(site, bundle.spawnArgs, bundle.filename, bundle.model);
            }
          });
          caps.push(cap);
        }
        return Promise.all(caps);
      } else {
        return;
      }
    } else {
      return;
    }
  })
  .catch(function(err) {
    common.errMsg(site, err);
  })
  .finally(function() {
    common.dbgMsg(site, 'Done, waiting ' + config.modelScanInterval + ' seconds.');
    setTimeout(function() { mainSiteLoop(site); }, config.modelScanInterval * 1000);
  });
}

mkdirp(config.captureDirectory, function(err) {
  if (err) {
    common.errMsg(null, err);
    process.exit(1);
  }
});

mkdirp(config.completeDirectory, function(err) {
  if (err) {
    common.errMsg(null, err);
    process.exit(1);
  }
});

function tryExit() {
  // SIGINT will get passed to any running ffmpeg captures.
  // Must delay exiting until the capture and postProcess
  // for all models have finished.  Keep checking every 1s
  var capsInProgress = 0;
  for (var i = 0; i < SITES.length; i++) {
    capsInProgress += SITES[i].getNumCapsInProgress();
  }
  if (semaphore === 0 && capsInProgress === 0) {
    if (config.enableMFC) {
      MFC.disconnect();
    }
    process.exit(0);
  } else {
    sleep(1000).then(() => {
      tryExit(); // recursion!
    });
  }
}

process.on('SIGINT', function() {
  // Prevent bad things from happening if user holds down ctrl+c
  if (!tryingToExit) {
    tryingToExit = 1;
    var capsInProgress = 0;
    for (var i = 0; i < SITES.length; i++) {
      capsInProgress += SITES[i].getNumCapsInProgress();
    }
    if (semaphore > 0 || capsInProgress > 0) {
      // extra newline to avoid ^C
      process.stdout.write('\n');
      common.msg(null, 'Waiting for ' + capsInProgress + ' capture stream(s) to end.');
    }
    tryExit();
  }
});

if (config.enableMFC) {
  MFC.create(MFC);
  Promise.try(function() {
    return MFC.connect();
  }).then(function() {
    common.msg(MFC, config.mfcmodels.length + ' model(s) in config');
    mainSiteLoop(MFC);
  }).catch(function(err) {
    common.errMsg(MFC, err);
  });
}

if (config.enableCB) {
  CB.create(CB);
  common.msg(CB, config.cbmodels.length + ' model(s) in config');
  mainSiteLoop(CB);
}

