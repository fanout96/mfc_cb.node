'use strict';
require('events').EventEmitter.prototype._maxListeners = 100;
var Promise = require('bluebird');
var fs = require('fs');
var yaml = require('js-yaml');
var moment = require('moment');
var mkdirp = require('mkdirp');
var S = require('string');
var WebSocketClient = require('websocket').client;
var http = require('http');
var bhttp = require('bhttp');
var cheerio = require('cheerio');
var colors = require('colors/safe');
var _ = require('underscore');
var childProcess = require('child_process');
var path = require('path');
var mfc = require("MFCAuto");

var session = bhttp.session();

function getCurrentDateTime() {
  return moment().format(config.dateFormat);
};

function initColors() {
  colors.setTheme({
    model: config.modelcolor, //'magenta',
    time:  config.timecolor,  //'grey',
    site:  config.sitecolor,  //'green',
    debug: config.debugcolor, //'yellow',
    error: config.errorcolor, // 'red',
  });
}

function printMsg(site, msg) {
  if (site == '') {
    console.log(colors.time('[' + getCurrentDateTime() + ']'), msg);
  } else {
    console.log(colors.time('[' + getCurrentDateTime() + ']'), colors.site(site), msg);
  }
}

function printErrorMsg(site, msg) {
  if (site == '') {
    console.log(colors.time('[' + getCurrentDateTime() + ']'), colors.error('[ERROR]'), msg);
  } else {
    console.log(colors.time('[' + getCurrentDateTime() + ']'), colors.site(site), colors.error('[ERROR]'), msg);
  }
}

function printDebugMsg(site, msg) {
  if (config.debug && msg) {
    if (site == '') {
      console.log(colors.time('[' + getCurrentDateTime() + ']'), colors.debug('[DEBUG]'), msg);
    } else {
      console.log(colors.time('[' + getCurrentDateTime() + ']'), colors.site(site), colors.debug('[DEBUG]'), msg);
    }
  }
}

// time in milliseconds
function sleep(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

function getMfcOnlineModels(fileno) {
  return Promise.try(function() {
    var onlineModels = mfc.Model.findModels((m) => true);
    printMsg('MFC', onlineModels.length  + ' model(s) online');
    return onlineModels;
  })
  .catch(function(err) {
    printErrorMsg('MFC', err.toString());
  });
}

function getCbOnlineModels(page) {

  return Promise.try(function() {
    return session.get("https://chaturbate.com/followed-cams/?page=" + page);
  }).then(function (response) {

    var $ = cheerio.load(response.body);

    // Get an array of models found on this page
    var currentModels = $("#main div.content ul.list").children("li")
    .filter(function(){
        return $(this).find("div.details ul.sub-info li.cams").text() != "offline";
    })
    .map(function(){
        return $(this).find("div.title a").text().trim().split(',');
    })
    .get();

    // Find the total number of model pages
    var pages = $("#main div.content ul.paging").children("li")
    .filter(function() {
        return $(this).find('a').text().trim() != 'next';
    })
    .map(function() {
        return $(this).find('a').text().trim();
    })
    .get();
    var totalPages = pages[pages.length-1];

    // Recurse until models on all pages are loaded
    if (page < totalPages) {
      return getCbOnlineModels(page+1)
      .then(function(models) {
        return currentModels.concat(models);
      })
      .catch(function(err) {
        printErrorMsg('CB ', err);
      })
    } else {
      return currentModels;
    }
  })
  .catch(function(err) {
    printErrorMsg('CB ', err.toString());
  });
}

function selectMfcMyModels(onlineModels) {
  if (onlineModels == null) {
    return;
  }

  return Promise.try(function() {
    printDebugMsg('MFC', config.mfcmodels.length + ' model(s) in config');

    var stats = fs.statSync('updates.yml');

    var includeMfcModels = [];
    var excludeMfcModels = [];

    if (stats.isFile()) {
      var updates = yaml.safeLoad(fs.readFileSync('updates.yml', 'utf8'));
      if (!updates.includeMfcModels) {
          updates.includeMfcModels = [];
      }

      if (!updates.excludeMfcModels) {
        updates.excludeMfcModels = [];
      }

      // first we push changes to main config
      if (updates.includeMfcModels.length > 0) {
        printMsg('MFC', updates.includeMfcModels.length + ' model(s) to include');

        includeMfcModels = updates.includeMfcModels;
      }

      if (updates.excludeMfcModels.length > 0) {
        printMsg('MFC', updates.excludeMfcModels.length + ' model(s) to exclude');

        excludeMfcModels = updates.excludeMfcModels;
      }

      // if there were some updates, then we reset updates.yml
      if (includeMfcModels.length > 0 || excludeMfcModels.length > 0) {
        updates.includeMfcModels = [];
        updates.excludeMfcModels = [];

        fs.writeFileSync('updates.yml', yaml.safeDump(updates), 0, 'utf8');
      }
    }

    var bundle = {includeMfcModels: includeMfcModels, excludeMfcModels: excludeMfcModels, dirty: false};
    return bundle;
  }).then(function(bundle) {

    // Fetch the UID of all models to add to capture list.
    // The model does not have to be online for this.
    var queries = [];
    for (var i = 0; i < bundle.includeMfcModels.length; i++) {
      var query = mfcGuest.queryUser(bundle.includeMfcModels[i]).then((model) => {
        var index = config.mfcmodels.indexOf(model.uid);
        if (index === -1) {
          printMsg('MFC', colors.model(model.nm) + colors.italic(' added') + ' to capture list');
          config.mfcmodels.push(model.uid);
          bundle.dirty = true;
        } else {
          printMsg('MFC', colors.model(model.nm) + ' is already in the capture list');
        }
      });
      queries.push(query);
    }

    return Promise.all(queries).then(function() {
      return bundle;
    });
  }).then(function(bundle) {
    // Fetch the UID of all models to be excluded.
    // The model does not have to be online for this
    var queries = [];
    for (var i = 0; i < bundle.excludeMfcModels.length; i++) {
      var query = mfcGuest.queryUser(bundle.excludeMfcModels[i]).then((model) => {
        var capIndex = mfcModelsCurrentlyCapturing.indexOf(model.uid);
        if (capIndex !== -1) {
          printMsg('MFC', colors.model(model.nm) + colors.italic(' removed') + ' from capture list, but is still currently capturing.');
        } else {
          printMsg('MFC', colors.model(model.nm) + colors.italic(' removed') + ' from capture list.');
        }
        config.mfcmodels = _.without(config.mfcmodels, model.uid);
        bundle.dirty = true;
      });
      queries.push(query);
    }

    return Promise.all(queries).then(function() {
      return bundle.dirty;
    });
  }).then(function(dirty) {
    if (dirty) {
      fs.writeFileSync('config.yml', yaml.safeDump(config), 0, 'utf8');
    }

    myMfcModels = [];
    return Promise.all(config.mfcmodels.map(checkMfcModelState));
  })
  .catch(function(err) {
    printErrorMsg('MFC', err.toString());
  });
}

function checkMfcModelState(uid) {

  return Promise.try(function() {
    // Query model by ID number
    return mfcGuest.queryUser(uid);
  }).then(function(model) {
    if (model !== undefined) {
      if (model.vs === mfc.STATE.FreeChat) {
        printMsg('MFC', colors.model(model.nm) + ' is in public chat!');
        myMfcModels.push(model);
      } else if (model.vs === mfc.STATE.GroupShow) {
        printMsg('MFC', colors.model(model.nm) + ' is in a group show');
      } else if (model.vs === mfc.STATE.Private) {
        if (model.truepvt) {
          printMsg('MFC', colors.model(model.nm) + ' is in a true private show.');
        } else {
          printMsg('MFC', colors.model(model.nm) + ' is in a private show.');
        }
      } else if (model.vs === mfc.STATE.Away) {
        printMsg('MFC', colors.model(model.nm) + ' is away');
      } else if (model.vs === mfc.STATE.Online) {
        printMsg('MFC', colors.model(model.nm + '\'s') + ' cam is off.');
      }
    }
    return true;
  })
  .catch(function(err) {
    printErrorMsg('MFC', err.toString());
  });
}

function selectCbMyModels(onlineModels) {
  if (onlineModels == null) {
    return;
  }

  printMsg('CB ', onlineModels.length  + ' model(s) online');

  return Promise.try(function() {
    printDebugMsg('CB ', config.cbmodels.length + ' model(s) in config');

    var stats = fs.statSync('updates.yml');

    var includeCbModels = [];
    var excludeCbModels = [];

    if (stats.isFile()) {
      var updates = yaml.safeLoad(fs.readFileSync('updates.yml', 'utf8'));

      if (!updates.includeCbModels) {
        updates.includeCbModels = [];
      }

      if (!updates.excludeCbModels) {
        updates.excludeCbModels = [];
      }

      // first we push changes to main config
      if (updates.includeCbModels.length > 0) {
        printMsg('CB ', updates.includeCbModels.length + ' model(s) to include');

        includeCbModels = updates.includeCbModels;
        updates.includeCbModels = [];
      }

      if (updates.excludeCbModels.length > 0) {
        printMsg('CB ', updates.excludeCbModels.length + ' model(s) to exclude');

        excludeCbModels = updates.excludeCbModels;
        updates.excludeCbModels = [];
      }

      // if there were some updates, then we reset updates.yml
      if (includeCbModels.length > 0 || excludeCbModels.length > 0) {
        fs.writeFileSync('updates.yml', yaml.safeDump(updates), 0, 'utf8');
      }
    }

    var bundle = {includeCbModels: includeCbModels, excludeCbModels: excludeCbModels, dirty: false};
    return bundle;
  }).then(function(bundle) {

    for (var i = 0; i < bundle.includeCbModels.length; i++) {
      var nm = bundle.includeCbModels[i];
      var index = config.cbmodels.indexOf(nm);
      if (index === -1) {
        printMsg('CB ', colors.model(nm) + colors.italic(' added') + ' to capture list');
        config.cbmodels.push(nm);
        bundle.dirty = true;
      } else {
        printMsg('CB ', colors.model(nm + ' is already in the capture list'));
      }
    }
    return bundle;
  }).then(function(bundle) {

    for (var i = 0; i < bundle.excludeCbModels.length; i++) {
      var nm = bundle.excludeCbModels[i];
      var index = config.cbmodels.indexOf(nm);
      if (index !== -1) {
        var capIndex = cbModelsCurrentlyCapturing.indexOf(nm);
        if (capIndex !== -1) {
          printMsg('CB ', colors.model(nm) + colors.italic(' removed') + ' from capture list, but is still currently capturing.');
        } else {
          printMsg('CB ', colors.model(nm) + colors.italic(' removed') + ' from capture list.');
        }
        config.cbmodels = _.without(config.cbmodels, nm);
        bundle.dirty = true;
      }
    }
    return bundle.dirty;
  }).then(function(dirty) {
    if (dirty) {
      printDebugMsg('CB ', "Rewriting config.yml");
      fs.writeFileSync('config.yml', yaml.safeDump(config), 0, 'utf8');
    }

    var myModels = [];

    _.each(config.cbmodels, function(nm) {
      var modelIndex = onlineModels.indexOf(nm);
      if (modelIndex !== -1) {
        myModels.push(nm);
      }
    });

    printDebugMsg('CB ', myModels.length  + ' model(s) to capture');

    return myModels;
  })
  .catch(function(err) {
    printErrorMsg('CB ', err.toString());
  });
}

function createMfcCaptureProcess(model) {
  if (mfcModelsCurrentlyCapturing.indexOf(model.uid) != -1) {
    printDebugMsg('MFC', colors.model(model.nm) + ' is already capturing');
    return; // resolve immediately
  }

  if (tryingToExit) {
    printDebugMsg('MFC', model.nm + ' capture not starting due to ctrl+c');
    return;
  }

  printMsg('MFC', colors.model(model.nm) + ', starting capturing process');

  return Promise.try(function() {
    var filename;
    if (config.includeSiteInFile) {
      filename = model.nm + '_mfc_' + getCurrentDateTime();
    } else {
      filename = model.nm + '_' + getCurrentDateTime();
    }
    mfcFilesCurrentlyCapturing.push(filename);
    var spawnArguments = [
      '-hide_banner',
      '-v',
      'fatal',
      '-i',
      'http://video' + (model.u.camserv - 500) + '.myfreecams.com:1935/NxServer/ngrp:mfc_' + (100000000 + model.uid) + '.f4v_mobile/playlist.m3u8',
      '-c',
      'copy',
      config.captureDirectory + '/' + filename + '.ts'
    ];

    var captureProcess = childProcess.spawn('ffmpeg', spawnArguments);

    captureProcess.stdout.on('data', function(data) {
      printMsg('MFC', data.toString);
    });

    captureProcess.stderr.on('data', function(data) {
      printMsg('MFC', data.toString);
    });

    captureProcess.on('close', function(code) {
      if (tryingToExit) {
        process.stdout.write(colors.site('MFC') + ' ' + colors.model(model.nm) + ' capture interrupted\n' + colors.time('[' + getCurrentDateTime() + '] '));
      } else {
        printMsg('MFC', colors.model(model.nm) + ' stopped streaming');
      }

      var modelIndex = mfcModelsCurrentlyCapturing.indexOf(model.uid);

      if (modelIndex !== -1) {
        mfcModelsCurrentlyCapturing.splice(modelIndex, 1);
      }

      fs.stat(config.captureDirectory + '/' + filename + '.ts', function(err, stats) {
        if (err) {
          if (err.code == 'ENOENT') {
            // do nothing, file does not exists
          } else {
            printErrorMsg('MFC', colors.model(model.nm) + ': ' + err.toString());
          }
        } else if (stats.size === 0) {
          fs.unlink(config.captureDirectory + '/' + filename + '.ts');
        } else {
          postProcess(filename);
        }
      });

      // Remove file from capturing list
      var index = mfcFilesCurrentlyCapturing.indexOf(filename);
      if (index !== -1) {
        mfcFilesCurrentlyCapturing.splice(index, 1);
      }
    });

    if (!!captureProcess.pid) {
      mfcModelsCurrentlyCapturing.push(model.uid);
    }
  })
  .catch(function(err) {
    printErrorMsg('MFC', colors.model(model.nm) + ': ' + err.toString());
  });
}

function getCbStream(modelName) {
  return Promise.try(function() {
    return session.get('https://chaturbate.com/' + modelName + '/');
  }).then(function (response) {
    var commandArguments = {
      modelName: modelName,
    };

    var $ = cheerio.load(response.body);

    var scripts = $('script')
    .map(function(){
      return $(this).text();
    }).get().join('');

    var streamData = scripts.match(/(https\:\/\/\w+\.stream\.highwebmedia\.com\/live-edge\/[\w\-]+\/playlist\.m3u8)/i);

    if (streamData !== null) {
      commandArguments.streamServer = streamData[1];
    } else {
      printErrorMsg('CB ', modelName + ' is offline');
    }

    return commandArguments;
  })
  .catch(function(err) {
    printErrorMsg('CB ', colors.model(modelName) + ': ' + err.toString());
  });
}

function createCbCaptureProcess(modelName) {
  if (cbModelsCurrentlyCapturing.indexOf(modelName) != -1) {
    printDebugMsg('CB ', colors.model(modelName) + ' is already capturing');
    return; // resolve immediately
  }

  if (tryingToExit) {
    printDebugMsg('CB ', colors.model(modelName) + ' is now online, but capture not started due to ctrl+c');
    return;
  }

  printMsg('CB ', colors.model(modelName) + ' is now online, starting capturing process');

  return Promise.try(function() {
    return getCbStream(modelName);
  }).then(function (commandArguments) {
    var filename;
    if (config.includeSiteInFile) {
      filename = commandArguments.modelName + '_cb_' + getCurrentDateTime();
    } else {
      filename = commandArguments.modelName + '_' + getCurrentDateTime();
    }
    cbFilesCurrentlyCapturing.push(filename);
    var spawnArguments = [
      '-hide_banner',
      '-v',
      'fatal',
      '-i',
      commandArguments.streamServer,
      '-c',
      'copy',
      config.captureDirectory + '/' + filename + '.ts'
    ];

    var captureProcess = childProcess.spawn('ffmpeg', spawnArguments);

    captureProcess.stdout.on('data', function(data) {
      printMsg('CB ', data.toString);
    });

    captureProcess.stderr.on('data', function(data) {
      printMsg('CB ', data.toString);
    });

    captureProcess.on('close', function(code) {
      if (tryingToExit) {
        process.stdout.write(colors.site('CB ') + ' ' + colors.model(commandArguments.modelName) + ' capture interrupted\n' + colors.time('[' + getCurrentDateTime() + '] '));
      } else {
        printMsg('CB ', colors.model(commandArguments.modelName) + ' stopped streaming');
      }

      var modelIndex = cbModelsCurrentlyCapturing.indexOf(modelName);

      if (modelIndex !== -1) {
        cbModelsCurrentlyCapturing.splice(modelIndex, 1);
      }

      fs.stat(config.captureDirectory + '/' + filename + '.ts', function(err, stats) {
        if (err) {
          if (err.code == 'ENOENT') {
            // do nothing, file does not exists
          } else {
            printErrorMsg('CB ', colors.model(commandArguments.modelName) + ' ' + err.toString());
          }
        } else if (stats.size === 0) {
          fs.unlink(config.captureDirectory + '/' + filename + '.ts');
        } else {
          postProcess(filename);
        }
      });

      // Remove file from capturing list
      var index = cbFilesCurrentlyCapturing.indexOf(filename);
      if (index !== -1) {
        cbFilesCurrentlyCapturing.splice(index, 1);
      }
    });

    if (!!captureProcess.pid) {
      cbModelsCurrentlyCapturing.push(modelName);
    }
  })
  .catch(function(err) {
    printErrorMsg('CB ', colors.model(modelName) + ' ' + err.toString());
  });
}

function postProcess(filename) {
  if (config.autoConvertType !== 'mp4' && config.autoConvertType !== 'mkv') {
    printDebugMsg('', 'Moving ' + config.captureDirectory + '/' + filename + '.ts to ' + config.completeDirectory + '/' + filename + '.ts');
    fs.rename(config.captureDirectory + '/' + filename + '.ts', config.completeDirectory + '/' + filename + '.ts', function(err) {
      if (err) {
        printErrorMsg('', colors.site(filename) + ': ' + err.toString());
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
      process.stdout.write(colors.debug('[DEBUG]') + ' Converting ' + filename + '.ts to ' + filename + '.' + config.autoConvertType + '\n' + colors.time('[' + getCurrentDateTime() + '] '));
    }
  } else {
    printDebugMsg('', 'Converting ' + filename + '.ts to ' + filename + '.' + config.autoConvertType);
  }

  var myCompleteProcess = childProcess.spawn('ffmpeg', mySpawnArguments);

  myCompleteProcess.stdout.on('data', function(data) {
    printMsg('', data.toString);
  });

  myCompleteProcess.stderr.on('data', function(data) {
    printMsg('', data.toString);
  });

  myCompleteProcess.on('close', function(code) {
    fs.unlink(config.captureDirectory + '/' + filename + '.ts');
    // For debug, to keep disk from filling during active testing
    if (config.autoDelete) {
      if (tryingToExit) {
        process.stdout.write(colors.error('[ERROR]') + ' Deleting ' + filename + '.' + config.autoConvertType + '\n' + colors.time('[' + getCurrentDateTime() + '] '));
      } else {
        printErrorMsg('', 'Deleting ' + filename + '.' + config.autoConvertType);
      }
      fs.unlink(config.completeDirectory + '/' + filename + '.' + config.autoConvertType);
    }
    semaphore--; // release semaphore only when ffmpeg process has ended
  });
}

function mainMfcLoop() {
  printDebugMsg('MFC', 'Start searching for new models');

  Promise .try(function() {
    return getMfcOnlineModels();
  })
  .then(function(onlineModels) {
    return selectMfcMyModels(onlineModels);
  })
  .then(function() {
    if (myMfcModels.length > 0) {
      printDebugMsg('MFC', myMfcModels.length  + ' model(s) to capture');
      return Promise.all(myMfcModels.map(createMfcCaptureProcess));
    } else {
      return;
    }
  })
  .catch(function(err) {
    printErrorMsg('MFC', err);
  })
  .finally(function() {
    printMsg('MFC', 'Done, will search for new models in ' + config.modelScanInterval + ' second(s).');
    setTimeout(mainMfcLoop, config.modelScanInterval * 1000);
  });
}

function mainCbLoop() {
  printDebugMsg('CB ', 'Start searching for new models');

  Promise.try(function() {
    return getCbOnlineModels(1);
  })
  .then(function(onlineModels) {
    return selectCbMyModels(onlineModels);
  })
  .then(function(myModels) {
    if (myModels != null) {
      return Promise.all(myModels.map(createCbCaptureProcess));
    } else {
      return;
    }
  })
  .catch(function(err) {
    printErrorMsg('CB ', err);
  })
  .finally(function() {
    printMsg('CB ', 'Done, will search for new models in ' + config.modelScanInterval + ' second(s).');
    setTimeout(mainCbLoop, config.modelScanInterval * 1000);
  });
}

var semaphore = 0; // Counting semaphore
var tryingToExit = 0;
var mfcGuest;
var myMfcModels = [];
var mfcModelsCurrentlyCapturing = new Array();
var mfcFilesCurrentlyCapturing = new Array();
var cbModelsCurrentlyCapturing = new Array();
var cbFilesCurrentlyCapturing = new Array();

var config = yaml.safeLoad(fs.readFileSync('config.yml', 'utf8'));

config.captureDirectory = path.resolve(config.captureDirectory);
config.completeDirectory = path.resolve(config.completeDirectory);

initColors();

mkdirp(config.captureDirectory, function(err) {
  if (err) {
    printErrorMsg('', err);
    process.exit(1);
  }
});

mkdirp(config.completeDirectory, function(err) {
  if (err) {
    printErrorMsg('', err);
    process.exit(1);
  }
});

function tryExit() {
  // SIGINT will get passed to any running ffmpeg captures.
  // Must delay exiting until the capture and postProcess
  // for all models have finished.  Keep checking every 1s
  if (semaphore == 0 && mfcFilesCurrentlyCapturing.length == 0 && cbFilesCurrentlyCapturing.length == 0) {
    process.stdout.write('\n');
    mfcGuest.disconnect();
    process.exit(0);
  } else {
    sleep(1000).then(() => {
      tryExit(); // recursion!
      // periodically print something so it is more
      // obvious that the script is not hung
      process.stdout.write('.');
    });
  }
}

process.on('SIGINT', function() {
  // Prevent bad things from happening if user holds down ctrl+c
  if (!tryingToExit) {
    tryingToExit = 1;
    if (semaphore > 0 || mfcFilesCurrentlyCapturing.length > 0 || cbFilesCurrentlyCapturing.length > 0) {
      // extra newline to avoid ^C
      process.stdout.write('\n');
      printMsg('', 'Waiting for ' + (mfcFilesCurrentlyCapturing.length + cbFilesCurrentlyCapturing.length) + ' capture stream(s) to end.');
      process.stdout.write(colors.time('[' + getCurrentDateTime() + '] ')); // log beautification
    }
    tryExit();
  }
})

if (config.enableMFC) {
  mfcGuest = new mfc.Client();
  Promise.try(function() {
    return mfcGuest.connectAndWaitForModels();
  }).then(function() {
    mainMfcLoop();
  });
}

if (config.enableCB) {
  mainCbLoop();
}

