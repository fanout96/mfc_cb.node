'use strict';
require('events').EventEmitter.prototype._maxListeners = 100;

// Load 3rd Party Libraries
var Promise      = require('bluebird');
var fs           = require('fs');
var yaml         = require('js-yaml');
var mkdirp       = require('mkdirp');
var S            = require('string');
var bhttp        = require('bhttp');
var colors       = require('colors/safe');
var _            = require('underscore');
var childProcess = require('child_process');
var path         = require('path');

// Load local libraries
var common       = require('./common');
var MFC          = require('./mfc');
var CB           = require('./cb');
var IF           = require('./if');

var session      = bhttp.session();
var semaphore    = 0; // Counting semaphore
var tryingToExit = 0;
var config       = yaml.safeLoad(fs.readFileSync('config.yml', 'utf8'));

config.captureDirectory  = path.resolve(config.captureDirectory);
config.completeDirectory = path.resolve(config.completeDirectory);

common.setSites(MFC, CB, IF);
common.initColors();

// time in milliseconds
function sleep(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

function getOnlineModels(site) {
  return site.getOnlineModels(1);
}

function selectMyModels(site, onlineModels) {
  if (onlineModels == null) {
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
  })
}

// Processes updates.yml and adds or removes models from config.yml
function processUpdates(site) {
  var len;
  switch (site) {
    case MFC: len = config.mfcmodels.length; break;
    case CB:  len = config.cbmodels.length;  break;
    case IF:  len = config.ifmodels.length;  break;
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

      case IF:
        if (!updates.includeIfModels) {
          updates.includeIfModels = [];
        } else if (updates.includeIfModels.length > 0) {
          common.msg(CB, updates.includeIfModels.length + ' model(s) to include');
          includeModels = updates.includeIfModels;
          updates.includeIfModels = [];
        }

        if (!updates.excludeIfModels) {
          updates.excludeIfModels = [];
        } else if (updates.excludeIfModels.length > 0) {
          common.msg(site, updates.excludeIfModels.length + ' model(s) to exclude');
          excludeModels = updates.excludeIfModels;
          updates.excludeIfModels = [];
        }
        break;
    }

    // if there were some updates, then rewrite updates.yml
    if (includeModels.length > 0 || excludeModels.length > 0) {
      fs.writeFileSync('updates.yml', yaml.safeDump(updates), 0, 'utf8');
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
    case IF:  index = config.ifmodels.indexOf(model);      nm = model;    break;
  }

  if (index === -1) {
    common.msg(site, colors.model(nm) + colors.italic(' added') + ' to capture list');

    switch (site) {
      case MFC: config.mfcmodels.push(model.uid); break;
      case CB:  config.cbmodels.push(nm);       break;
      case IF:  config.ifmodels.push(nm);       break;
    }

    return true;
  } else {
    common.msg(site, colors.model(nm) + ' is already in the capture list');
  }

  return false;
}

function addModels(site, bundle) {

  switch (site) {
    case MFC:
      // Fetch the UID of new models to add to capture list.
      // The model does not have to be online for this.
      var queries = [];
      for (var i = 0; i < bundle.includeModels.length; i++) {
        var query = MFC.queryUser(bundle.includeModels[i]).then((model) => {
          bundle.dirty |= addModel(site, model);
        });
        queries.push(query);
      }

      return Promise.all(queries).then(function() {
        return bundle;
      });
      break;

    case CB:
    case IF:
      for (var i = 0; i < bundle.includeModels.length; i++) {
        var nm = bundle.includeModels[i];
        bundle.dirty |= addModel(site, nm);
      }
      return bundle;
      break;
  }
  return;
}

function removeModel(site, model) {
  var match;
  var nm;

  switch (site) {
    case MFC: match = model.uid; nm = model.nm; break;
    case CB:
    case IF:  match = model;     nm = model;    break;
  }

  var index = site.getModelsCurrentlyCapturing(match);
  if (index !== -1) {
    common.msg(site, colors.model(nm) + colors.italic(' removed') + ' from capture list, but is still currently capturing.');
  } else {
    common.msg(site, colors.model(nm) + colors.italic(' removed') + ' from capture list.');
  }

  switch (site) {
    case MFC: config.mfcmodels = _.without(config.mfcmodels, model.uid); break;
    case CB:  config.cbmodels  = _.without(config.cbmodels,  model);     break;
    case IF:  config.ifmodels  = _.without(config.cbmodels,  model);     break;
  }

  return true;
}

function removeModels(site, bundle) {
  switch (site) {
    case MFC:
      // Fetch the UID of current models to be excluded from capture list.
      // The model does not have to be online for this.
      var queries = [];
      for (var i = 0; i < bundle.excludeModels.length; i++) {
        var query = MFC.queryUser(bundle.excludeModels[i]).then((model) => {
          bundle.dirty |= removeModel(site, model);
        });
        queries.push(query);
      }

      return Promise.all(queries).then(function() {
        return bundle.dirty;
      });
      break;

    case CB:
    case IF:
      for (var i = 0; i < bundle.excludeModels.length; i++) {
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
    common.dbgMsg(site, "Rewriting config.yml");
    fs.writeFileSync('config.yml', yaml.safeDump(config), 0, 'utf8');
  }

  switch (site) {
    case MFC:
      MFC.clearMyModels();
      return Promise.all(config.mfcmodels.map(MFC.checkModelState))
      .then(function() {
        return MFC.getMyModels();
      })
      .catch(function(err) {
        common.errMsg(site, err.toString());
      });
      break;

    case CB:
      var myModels = [];
      _.each(config.cbmodels, function(nm) {
        var modelIndex = onlineModels.indexOf(nm);
        if (modelIndex !== -1) {
          myModels.push(nm);
        }
      });
      return myModels;
      break;

    case IF:
      var myModels = [];
      _.each(config.ifmodels, function(nm) {
        var modelIndex = onlineModels.indexOf(nm);
        if (modelIndex !== -1) {
          myModels.push(nm);
        }
      });
      return myModels;
      break;
  }
  return myModels;
}

function removeModelFromCapList(site, model) {
  var modelsCurrentlyCapturing;
  var match;

  modelsCurrentlyCapturing = site.getModelsCurrentlyCapturing();

  switch (site) {
    case MFC: match = model.uid; break;
    case CB:
    case IF:  match = model;     break;
  }

  // Remove from the currently capturing list
  var modelIndex = modelsCurrentlyCapturing.indexOf(match);
  if (modelIndex !== -1) {
    modelsCurrentlyCapturing.splice(modelIndex, 1);
    site.setModelsCurrentlyCapturing(modelsCurrentlyCapturing);
  }
}

function removeFileFromCapList(site, filename) {
  var filesCurrentlyCapturing = site.getFilesCurrentlyCapturing();

  var index = filesCurrentlyCapturing.indexOf(filename);
  if (index !== -1) {
    filesCurrentlyCapturing.splice(index, 1);
    site.setFilesCurrentlyCapturing(filesCurrentlyCapturing);
  }
}

function startCapture(site, spawnArgs, filename, model) {
  var nm;
  switch (site) {
    case MFC: nm = model.nm; break;
    case CB:
    case IF:  nm = model; break;
  };

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

  captureProcess.on('close', function(code) {
    // TODO: Since IF currently launches 4 ffmpeg procesess with 3
    //       expected to fail, ignore common when the ffmpeg
    //       process ends.
    if (site != IF) {
      if (tryingToExit) {
        process.stdout.write(colors.site(common.getSiteName(site)) + ' ' + colors.model(nm) + ' capture interrupted\n' + colors.time('[' + common.getDateTime() + '] '));
      } else {
        common.msg(site, colors.model(nm) + ' stopped streaming');
      }
    }

    removeModelFromCapList(site, model);

    fs.stat(config.captureDirectory + '/' + filename + '.ts', function(err, stats) {
      if (err) {
        if (err.code == 'ENOENT') {
          // Since IF launches 4 ffmpeg jobs, and 3 are guaranteed to fail
          // do not common this error for IF.
          // TODO: remove this conditional once automatic IF server discovery is
          //       figured out.
          if (site != IF) {
            if (tryingToExit) {
              process.stdout.write(colors.site(getSiteName(site)) + ' ' + colors.error('[ERROR] ') + colors.model(nm) + ': ' + filename + '.ts not found in capturing directory, cannot convert to ' + config.autoConvertType);
            } else {
              common.errMsg(site, colors.model(nm) + ': ' + filename + '.ts not found in capturing directory, cannot convert to ' + config.autoConvertType);
            }
          }
        } else {
          if (tryingToExit) {
            process.stdout.write(colors.site(getSiteName(site)) + ' ' + colors.error('[ERROR] ') + colors.model(nm) + ': ' +err.toString());
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

    removeFileFromCapList(site, filename);
  });

  if (!!captureProcess.pid) {
    switch (site) {
      case MFC: MFC.addModelToCurrentlyCapturing(model.uid); break;
      case CB:
      case IF:  site.addModelToCurrentlyCapturing(model);    break;
    }
  }
}

function postProcess(filename) {
  if (config.autoConvertType !== 'mp4' && config.autoConvertType !== 'mkv') {
    common.dbgMsg(null, 'Moving ' + config.captureDirectory + '/' + filename + '.ts to ' + config.completeDirectory + '/' + filename + '.ts');
    fs.rename(config.captureDirectory + '/' + filename + '.ts', config.completeDirectory + '/' + filename + '.ts', function(err) {
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

  myCompleteProcess.on('close', function(code) {
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

function mainSiteLoop(site) {
  common.dbgMsg(site, 'Start searching for new models');

  Promise.try(function() {
    return getOnlineModels(site);
  })
  .then(function(onlineModels) {
    common.msg(site, onlineModels.length  + ' model(s) online');
    return selectMyModels(site, onlineModels);
  })
  .then(function(myModels) {
    if (myModels != null) {
      if (myModels.length > 0) {
        common.dbgMsg(site, myModels.length + ' model(s) to capture');
        var caps = [];
        for (var i = 0; i < myModels.length; i++) {
          var cap = site.setupCapture(myModels[i], tryingToExit).then(function(jobs) {
            for (var j = 0; j < jobs.length; j++) {
              if (jobs[j].spawnArgs != '') {
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
    setTimeout(function() { mainSiteLoop(site) }, config.modelScanInterval * 1000);
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
  if (semaphore == 0 && MFC.getFilesCurrentlyCapturing().length == 0 && CB.getFilesCurrentlyCapturing().length == 0 && IF.getFilesCurrentlyCapturing().length == 0) {
    process.stdout.write('\n');
    if (config.enableMFC) {
      MFC.disconnect();
    }
    process.exit(0);
  } else {
    sleep(1000).then(() => {
      tryExit(); // recursion!
      // periodically common something so it is more
      // obvious that the script is not hung
      process.stdout.write('.');
    });
  }
}

process.on('SIGINT', function() {
  // Prevent bad things from happening if user holds down ctrl+c
  if (!tryingToExit) {
    tryingToExit = 1;
    if (semaphore > 0 || MFC.getFilesCurrentlyCapturing().length > 0 || CB.getFilesCurrentlyCapturing().length > 0 || IF.getFilesCurrentlyCapturing().length > 0) {
      var capsInProgress = MFC.getFilesCurrentlyCapturing().length + CB.getFilesCurrentlyCapturing().length + IF.getFilesCurrentlyCapturing().length;
      // extra newline to avoid ^C
      process.stdout.write('\n');
      common.msg(null, 'Waiting for ' + capsInProgress + ' capture stream(s) to end.');
      process.stdout.write(colors.time('[' + common.getDateTime() + '] ')); // log beautification
    }
    tryExit();
  }
})

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

if (config.enableIF) {
  IF.create(IF);
  mainSiteLoop(IF);
}

