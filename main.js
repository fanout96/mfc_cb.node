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
  var len;
  switch (site) {
    case MFC: len = config.mfcmodels.length; break;
    case CB:  len = config.cbmodels.length;  break;
  }
  common.dbgMsg(site, len + ' model(s) in config');

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

  var bundle = {includeModels: includeModels, excludeModels: excludeModels, dirty: false};
  return bundle;
}

function addModel(site, model) {
  var index;
  var nm;

  switch (site) {
    case MFC: index = config.mfcmodels.indexOf(model.uid); nm = model.nm; break;
    case CB:  index = config.cbmodels.indexOf(model);      nm = model;    break;
  }

  if (index === -1) {
    common.msg(site, colors.model(nm) + colors.italic(' added') + ' to capture list');

    switch (site) {
      case MFC: config.mfcmodels.push(model.uid); break;
      case CB:  config.cbmodels.push(nm);         break;
    }

    return true;
  } else {
    common.msg(site, colors.model(nm) + ' is already in the capture list');
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
        var nm = bundle.includeModels[i];
        bundle.dirty |= addModel(site, nm);
      }
      return bundle;
  }
  return;
}

function removeModel(site, model) {
  var match;
  var nm;

  switch (site) {
    case MFC: match = model.uid; nm = model.nm; break;
    case CB:  match = model;     nm = model;    break;
  }

  common.msg(site, colors.model(nm) + colors.italic(' removed') + ' from capture list.');
  site.haltCapture(match);

  switch (site) {
    case MFC: config.mfcmodels = _.without(config.mfcmodels, model.uid); break;
    case CB:  config.cbmodels  = _.without(config.cbmodels,  model);     break;
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
          bundle.dirty |= removeModel(site, nm);
        }
      }
      return bundle.dirty;
  }
  return;
}

function writeConfig(site, onlineModels, dirty) {
  if (dirty) {
    common.dbgMsg(site, 'Rewriting config.yml');
    fs.writeFileSync('config.yml', yaml.safeDump(config), 'utf8');
  }

  var modelsToCap = [];
  switch (site) {
    case MFC:
      MFC.clearMyModels();
      return Promise.all(config.mfcmodels.map(MFC.checkModelState))
      .then(function() {
        return MFC.getModelsToCap();
      })
      .catch(function(err) {
        common.errMsg(site, err.toString());
      });

    case CB:
      _.each(config.cbmodels, function(nm) {
        var modelIndex = onlineModels.indexOf(nm);
        if (modelIndex !== -1) {
          modelsToCap.push(nm);
        }
      });
      return modelsToCap;
  }
}

function getModelsToCap(site, onlineModels) {
  if (onlineModels === null) {
    return;
  }
  return Promise.try(function() {
    return processUpdates(site);
  })
  .then(function(bundle) {
    return addModels(site, bundle);
  })
  .then(function(bundle) {
    return removeModels(site, bundle);
  })
  .then(function(dirty) {
    return writeConfig(site, onlineModels, dirty);
  })
  .catch(function(err) {
    common.errMsg(site, err);
  });
}

function removeModelFromCapList(site, model) {
  var index;

  switch (site) {
    case MFC: index = model.uid; break;
    case CB:  index = model;     break;
  }

  site.removeModelFromCapList(index);
}

function postProcess(filename) {
  if (config.autoConvertType !== 'mp4' && config.autoConvertType !== 'mkv') {
    common.dbgMsg(null, 'Moving ' + config.captureDirectory + '/' + filename + '.ts to ' + config.completeDirectory + '/' + filename + '.ts');
    mv(config.captureDirectory + '/' + filename + '.ts', config.completeDirectory + '/' + filename + '.ts', function(err) {
      if (err) {
        common.errMsg(null, colors.site(filename) + ': ' + err.toString());
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
      '-bsf:a',
      'aac_adtstoasc',
      '-copyts',
      config.completeDirectory + '/' + filename + '.' + config.autoConvertType
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
      '-copyts',
      config.completeDirectory + '/' + filename + '.' + config.autoConvertType
    ];
  }

  semaphore++;

  if (tryingToExit) {
    if (config.debug) {
      process.stdout.write(colors.debug('[DEBUG]') + ' Converting ' + filename + '.ts to ' + filename + '.' + config.autoConvertType + '\n' + colors.time('[' + common.getDateTime() + '] '));
    }
  } else {
    common.dbgMsg(null, 'Converting ' + filename + '.ts to ' + filename + '.' + config.autoConvertType);
  }

  var myCompleteProcess = childProcess.spawn('ffmpeg', mySpawnArguments);

  myCompleteProcess.stdout.on('data', function(data) {
    common.msg(null, data);
  });

  myCompleteProcess.stderr.on('data', function(data) {
    common.msg(null, data);
  });

  myCompleteProcess.on('close', function() {
    fs.unlink(config.captureDirectory + '/' + filename + '.ts');
    // For debug, to keep disk from filling during active testing
    if (config.autoDelete) {
      if (tryingToExit) {
        process.stdout.write(colors.error('[ERROR]') + ' Deleting ' + filename + '.' + config.autoConvertType + '\n' + colors.time('[' + common.getDateTime() + '] '));
      } else {
        common.errMsg(null, 'Deleting ' + filename + '.' + config.autoConvertType);
      }
      fs.unlink(config.completeDirectory + '/' + filename + '.' + config.autoConvertType);
    }
    semaphore--; // release semaphore only when ffmpeg process has ended
  });

  myCompleteProcess.on('error', function(err) {
    common.errMsg(null, err);
  });
}

function startCapture(site, spawnArgs, filename, model) {
  var nm;
  switch (site) {
    case MFC: nm = model.nm; break;
    case CB:  nm = model;    break;
  }

  //common.dbgMsg(site, 'Launching ffmpeg ' + spawnArgs);
  var captureProcess = childProcess.spawn('ffmpeg', spawnArgs);

  captureProcess.stdout.on('data', function(data) {
    common.msg(site, data);
  });

  captureProcess.stderr.on('data', function(data) {
    common.msg(site, data);
  });

  captureProcess.on('error', function(err) {
    common.dbgMsg(site, err);
  });

  captureProcess.on('close', function() {
    if (tryingToExit) {
      process.stdout.write(colors.site(common.getSiteName(site)) + ' ' + colors.model(nm) + ' capture interrupted\n' + colors.time('[' + common.getDateTime() + '] '));
    } else {
      common.msg(site, colors.model(nm) + ' stopped streaming');
    }

    fs.stat(config.captureDirectory + '/' + filename + '.ts', function(err, stats) {
      if (err) {
        if (err.code == 'ENOENT') {
          if (tryingToExit) {
            process.stdout.write(colors.site(common.getSiteName(site)) + ' ' + colors.error('[ERROR] ') + colors.model(nm) + ': ' + filename + '.ts not found in capturing directory, cannot convert to ' + config.autoConvertType);
          } else {
            common.errMsg(site, colors.model(nm) + ': ' + filename + '.ts not found in capturing directory, cannot convert to ' + config.autoConvertType);
          }
        } else {
          if (tryingToExit) {
            process.stdout.write(colors.site(common.getSiteName(site)) + ' ' + colors.error('[ERROR] ') + colors.model(nm) + ': ' +err.toString());
          } else {
            common.errMsg(site, colors.model(nm) + ': ' + err.toString());
          }
        }
      } else if (stats.size === 0) {
        fs.unlink(config.captureDirectory + '/' + filename + '.ts');
      } else {
        postProcess(filename);
      }
    });

    removeModelFromCapList(site, model);
  });

  if (!!captureProcess.pid) {
    switch (site) {
      case MFC: site.addModelToCapList(model.uid, filename, captureProcess.pid); break;
      case CB:  site.addModelToCapList(model,     filename, captureProcess.pid); break;
    }
  }
}

function mainSiteLoop(site) {
  common.dbgMsg(site, 'Start searching for new models');

  Promise.try(function() {
    return site.getOnlineModels();
  })
  .then(function(onlineModels) {
    if (typeof onlineModels !== 'undefined') {
      common.msg(site, onlineModels.length  + ' model(s) online');
      return getModelsToCap(site, onlineModels);
    } else {
      return null;
    }
  })
  .then(function(modelsToCap) {
    if (modelsToCap !== null) {
      if (modelsToCap.length > 0) {
        common.dbgMsg(site, modelsToCap.length + ' model(s) to capture');
        var caps = [];
        for (var i = 0; i < modelsToCap.length; i++) {
          var cap = site.setupCapture(modelsToCap[i], tryingToExit).then(function(jobs) {
            for (var j = 0; j < jobs.length; j++) {
              if (jobs[j].spawnArgs !== '') {
                startCapture(site, jobs[j].spawnArgs, jobs[j].filename, jobs[j].model);
              }
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
    common.msg(site, 'Done, will search for new models in ' + config.modelScanInterval + ' second(s).');
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
    process.stdout.write('\n');
    if (config.enableMFC) {
      MFC.disconnect();
    }
    process.exit(0);
  } else {
    sleep(1000).then(() => {
      tryExit(); // recursion!
      // periodically print something so it is more obvious
      // that the script is not hung while waiting on ffmpeg
      process.stdout.write('.');
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
      process.stdout.write(colors.time('[' + common.getDateTime() + '] ')); // log beautification
    }
    tryExit();
  }
});

if (config.enableMFC) {
  MFC.create(MFC);
  Promise.try(function() {
    return MFC.connect();
  }).then(function() {
    mainSiteLoop(MFC);
  }).catch(function(err) {
    common.errMsg(MFC, err);
  });
}

if (config.enableCB) {
  CB.create(CB);
  mainSiteLoop(CB);
}

