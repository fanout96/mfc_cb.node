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

var MFC = 'MFC'; // MyFreeCams
var CB  = 'CB '; // Chaturbate
var IF  = 'IF '; // iFriends

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

function getOnlineModels(site) {
  switch (site) {
    case MFC: return getMfcOnlineModels(); break;
    case CB:  return getCbOnlineModels(1); break;
    case IF:  return getIfOnlineModels(1); break;
    default:  printErrorMsg(site, 'getOnlineModels: unhandled site ' + site); break;
  }
  return;
}

function getMfcOnlineModels() {
  return Promise.try(function() {
    var onlineModels = mfc.Model.findModels((m) => true);
    return onlineModels;
  })
  .catch(function(err) {
    printErrorMsg(MFC, err.toString());
  });
}

function getCbOnlineModels(page) {

  return Promise.try(function() {
    return session.get('https://chaturbate.com/followed-cams/?page=' + page);
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

    //printDebugMsg(CB, 'Fetching page ' + page + '/' + totalPages);

    // Recurse until models on all pages are loaded
    if (page < totalPages) {
      return getCbOnlineModels(page+1)
      .then(function(models) {
        return currentModels.concat(models);
      })
      .catch(function(err) {
        printErrorMsg(CB, err);
      })
    } else {
      return currentModels;
    }
  })
  .catch(function(err) {
    printErrorMsg(CB, err.toString());
  });
}

function getIfOnlineModels(page) {
  return Promise.try(function() {
    return session.get('http://www.ifriends.net/userurl_membrg2/livehosts/all-cam-girls/live-now/?pLoopPageOffset=' + page + '&p_ckname_liveBrowse=list');
  }).then(function (response) {
    var $ = cheerio.load(response.body);

    // Get an array of models found on this page
    var currentModels = $(".lb-tablerow-content")
    .map(function() {
      return $(this).find('b').text().split(',');
    })
    .get();
    //printDebugMsg(IF, 'currentModels = ' + currentModels);

    // Get the total number of pages to load
    var scripts = $('script')
    .map(function(){
      return $(this).text();
    }).get().join('');

    var pages = scripts.match(/(pager-last.*[\s\S].*appendOrReplaceURLParameter.*pLoopPageOffset.*(0|[1-9][0-9]))/i);
    if (pages == null) {
      return currentModels;
    } else {
      var totalPages = pages[pages.length-1];

      //printDebugMsg(IF, 'Fetching page ' + page + '/' + totalPages);

      // Recurse until models on all pages are loaded
      if (page < totalPages) {
        return getIfOnlineModels(page+1)
        .then(function(models) {
          return currentModels.concat(models);
        })
        .catch(function(err) {
          printErrorMsg(IF, err);
        })
      } else {
        return currentModels;
      }
    }
  })
  .catch(function(err) {
    printDebugMsg(IF, err);
  });
  return;
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
    printErrorMsg(site, err);
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
  printDebugMsg(site, len + ' model(s) in config');

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
          printMsg(site, updates.includeMfcModels.length + ' model(s) to include');
          includeModels = updates.includeMfcModels;
          updates.includeMfcModels = [];
        }

        if (!updates.excludeMfcModels) {
          updates.excludeMfcModels = [];
        } else if (updates.excludeMfcModels.length > 0) {
          printMsg(site, updates.excludeMfcModels.length + ' model(s) to exclude');
          excludeModels = updates.excludeMfcModels;
          updates.excludeMfcModels = [];
        }
        break;

      case CB:
        if (!updates.includeCbModels) {
          updates.includeCbModels = [];
        } else if (updates.includeCbModels.length > 0) {
          printMsg(CB, updates.includeCbModels.length + ' model(s) to include');
          includeModels = updates.includeCbModels;
          updates.includeCbModels = [];
        }

        if (!updates.excludeCbModels) {
          updates.excludeCbModels = [];
        } else if (updates.excludeMfcModels.length > 0) {
          printMsg(site, updates.excludeMfcModels.length + ' model(s) to exclude');
          excludeModels = updates.excludeMfcModels;
          updates.excludeMfcModels = [];
        }
        break;

      case IF:
        if (!updates.includeIfModels) {
          updates.includeIfModels = [];
        } else if (updates.includeIfModels.length > 0) {
          printMsg(CB, updates.includeIfModels.length + ' model(s) to include');
          includeModels = updates.includeIfModels;
          updates.includeIfModels = [];
        }

        if (!updates.excludeIfModels) {
          updates.excludeIfModels = [];
        } else if (updates.excludeMfcModels.length > 0) {
          printMsg(site, updates.excludeMfcModels.length + ' model(s) to exclude');
          excludeModels = updates.excludeMfcModels;
          updates.excludeMfcModels = [];
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
    printMsg(site, colors.model(name) + colors.italic(' added') + ' to capture list');

    switch (site) {
      case MFC: config.mfcmodels.push(model.uid); break;
      case CB:  config.cbmodels.push(name);       break;
      case IF:  config.ifmodels.push(name);       break;
    }

    return true;
  } else {
    printMsg(site, colors.model(name) + ' is already in the capture list');
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
        var query = mfcGuest.queryUser(bundle.includeModels[i]).then((model) => {
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
  var index;
  var nm;

  switch (site) {
    case MFC: index = mfcModelsCurrentlyCapturing.indexOf(model.uid); nm = model.nm; break;
    case CB:  index = cbModelsCurrentlyCapturing.indexOf(model);      nm = model;    break;
    case IF:  index = ifModelsCurrentlyCapturing.indexOf(model);      nm = model;    break;
  }

  if (index !== -1) {
    printMsg(site, colors.model(nm) + colors.italic(' removed') + ' from capture list, but is still currently capturing.');
  } else {
    printMsg(site, colors.model(nm) + colors.italic(' removed') + ' from capture list.');
  }

  switch (site) {
    case MFC: config.mfcmodels = _.without(config.mfcmodels, model.uid); break;
    case CB:  config.cbmodels  = _.without(config.cbmodels, model);      break;
    case IF:  config.ifmodels  = _.without(config.cbmodels, model);      break;
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
        var query = mfcGuest.queryUser(bundle.excludeModels[i]).then((model) => {
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
          bundle.dirty |= removeModel(site, model);
        }
      }
      return bundle.dirty;
  }
  return;
}

function writeConfig(site, onlineModels, dirty) {
  if (dirty) {
    printDebugMsg(site, "Rewriting config.yml");
    fs.writeFileSync('config.yml', yaml.safeDump(config), 0, 'utf8');
  }

  switch (site) {
    case MFC:
      myMfcModels = [];
      return Promise.all(config.mfcmodels.map(checkMfcModelState))
      .then(function() {
          return myMfcModels;
      })
      .catch(function(err) {
        printErrorMsg(site, err.toString());
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
  var myModels = [];
  return myModels;
}

function checkMfcModelState(uid) {

  return Promise.try(function() {
    // Query model by ID number
    return mfcGuest.queryUser(uid);
  }).then(function(model) {
    if (model !== undefined) {
      if (model.vs === mfc.STATE.FreeChat) {
        printMsg(MFC, colors.model(model.nm) + ' is in public chat!');
        myMfcModels.push(model);
      } else if (model.vs === mfc.STATE.GroupShow) {
        printMsg(MFC, colors.model(model.nm) + ' is in a group show');
      } else if (model.vs === mfc.STATE.Private) {
        if (model.truepvt) {
          printMsg(MFC, colors.model(model.nm) + ' is in a true private show.');
        } else {
          printMsg(MFC, colors.model(model.nm) + ' is in a private show.');
        }
      } else if (model.vs === mfc.STATE.Away) {
        printMsg(MFC, colors.model(model.nm) + ' is away');
      } else if (model.vs === mfc.STATE.Online) {
        printMsg(MFC, colors.model(model.nm + '\'s') + ' cam is off.');
      }
    }
    return true;
  })
  .catch(function(err) {
    printErrorMsg(MFC, err.toString());
  });
}

function getFileName(site, nm) {
  var filename;
  if (config.includeSiteInFile) {
    filename = nm + '_' + site.trim().toLowerCase() + '_' + getCurrentDateTime();
  } else {
    filename = nm + '_' + getCurrentDateTime();
  }
  return filename;
}

function getCaptureArguments(url, filename) {
  var spawnArgs = [
    '-hide_banner',
    '-v',
    'fatal',
    '-i',
    url,
    // TODO: Some models get AV sync issues after a long time of recording.
    //       Will experiment with a per-model option to enable ffmpeg audio
    //       resampling to try and correct for sync issues.
    //'-af',
    //'aresample=async=1',
    //'-vcodec',
    '-c',
    'copy',
    config.captureDirectory + '/' + filename + '.ts'
  ];
  return spawnArgs;
}

function removeModelFromCapList(site, model) {
  var modelsCurrentlyCapturing;
  var match;

  switch (site) {
    case MFC: modelsCurrentlyCapturing = mfcModelsCurrentlyCapturing; match = model.uid; break;
    case CB:  modelsCurrentlyCapturing = cbModelsCurrentlyCapturing;  match = model;     break;
    case IF:  modelsCurrentlyCapturing = ifModelsCurrentlyCapturing;  match = model;     break;
  }

  // Remove from the currently capturing list
  var modelIndex = modelsCurrentlyCapturing.indexOf(match);
  if (modelIndex !== -1) {
    modelsCurrentlyCapturing.splice(modelIndex, 1);
  }

  switch (site) {
    case MFC: mfcModelsCurrentlyCapturing = modelsCurrentlyCapturing; break;
    case CB:  mfcModelsCurrentlyCapturing = modelsCurrentlyCapturing; break;
    case IF:  ifModelsCurrentlyCapturing  = modelsCurrentlyCapturing; break;
  }
}

function removeFileFromCapList(site, filename) {
  var filesCurrentlyCapturing;

  switch (site) {
    case MFC: filesCurrentlyCapturing = mfcFilesCurrentlyCapturing; break;
    case CB:  filesCurrentlyCapturing = cbFilesCurrentlyCapturing;  break;
    case IF:  filesCurrentlyCapturing = ifFilesCurrentlyCapturing;  break;
  }

  var index = filesCurrentlyCapturing.indexOf(filename);
  if (index !== -1) {
    filesCurrentlyCapturing.splice(index, 1);
  }

  switch (site) {
    case MFC: mfcFilesCurrentlyCapturing = filesCurrentlyCapturing; break;
    case CB:  cbFilesCurrentlyCapturing  = filesCurrentlyCapturing; break;
    case IF:  ifFilesCurrentlyCapturing  = filesCurrentlyCapturing; break;
  }
}

function startCapture(site, spawnArgs, filename, model) {
  var nm;
  switch (site) {
    case MFC: nm = model.nm; break;
    case CB:
    case IF:  nm = model; break;
  };

  //printDebugMsg(site, 'Launching ffmpeg ' + spawnArgs);
  var captureProcess = childProcess.spawn('ffmpeg', spawnArgs);

  captureProcess.stdout.on('data', function(data) {
    printMsg(site, data);
  });

  captureProcess.stderr.on('data', function(data) {
    printMsg(site, data);
  });

  captureProcess.on('error', function(err) {
    printDebugMsg(site, err);
  });

  captureProcess.on('close', function(code) {
    // TODO: Since IF currently launches 4 ffmpeg procesess with 3
    //       expected to fail, ignore printing when the ffmpeg
    //       process ends.
    if (site != IF) {
      if (tryingToExit) {
        process.stdout.write(colors.site(site) + ' ' + colors.model(nm) + ' capture interrupted\n' + colors.time('[' + getCurrentDateTime() + '] '));
      } else {
        printMsg(site, colors.model(nm) + ' stopped streaming');
      }
    }

    removeModelFromCapList(site, model);

    fs.stat(config.captureDirectory + '/' + filename + '.ts', function(err, stats) {
      if (err) {
        if (err.code == 'ENOENT') {
          // Since IF launches 4 ffmpeg jobs, and 3 are guaranteed to fail
          // do not print this error for IF.
          // TODO: remove this conditional once automatic IF server discovery is
          //       figured out.
          if (site != IF) {
            if (tryingToExit) {
              process.stdout.write(colors.site(site) + ' ' + colors.error('[ERROR] ') + colors.model(nm) + ': ' + filename + '.ts not found in capturing directory, cannot convert to ' + config.autoConvertType);
            } else {
              printErrorMsg(site, colors.model(nm) + ': ' + filename + '.ts not found in capturing directory, cannot convert to ' + config.autoConvertType);
            }
          }
        } else {
          if (tryingToExit) {
            process.stdout.write(colors.site(site) + ' ' + colors.error('[ERROR] ') + colors.model(nm) + ': ' +err.toString());
          } else {
            printErrorMsg(site, colors.model(nm) + ': ' + err.toString());
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
      case MFC: mfcModelsCurrentlyCapturing.push(model.uid); break;
      case CB:  cbModelsCurrentlyCapturing.push(model);      break;
      case IF:  ifModelsCurrentlyCapturing.push(model);      break;
    }
  }
}

function createMfcCaptureProcess(model) {
  if (mfcModelsCurrentlyCapturing.indexOf(model.uid) != -1) {
    printDebugMsg(MFC, colors.model(model.nm) + ' is already capturing');
    return;
  }

  if (tryingToExit) {
    printDebugMsg(MFC, model.nm + ' capture not starting due to ctrl+c');
    return;
  }

  printMsg(MFC, colors.model(model.nm) + ', starting capture process');

  return Promise.try(function() {
    var filename = getFileName(MFC, model.nm);
    mfcFilesCurrentlyCapturing.push(filename);

    var spawnArgs = getCaptureArguments('http://video' + (model.u.camserv - 500) + '.myfreecams.com:1935/NxServer/ngrp:mfc_' + (100000000 + model.uid) + '.f4v_mobile/playlist.m3u8', filename);

    startCapture(MFC, spawnArgs, filename, model);
  })
  .catch(function(err) {
    printErrorMsg(MFC, colors.model(model.nm) + ': ' + err.toString());
  });
}

function getCbStream(nm) {
  return Promise.try(function() {
    return session.get('https://chaturbate.com/' + nm + '/');
  }).then(function (response) {
    var cmdargs = {
      nm: nm,
    };

    var $ = cheerio.load(response.body);

    var scripts = $('script')
    .map(function(){
      return $(this).text();
    }).get().join('');

    var streamData = scripts.match(/(https\:\/\/\w+\.stream\.highwebmedia\.com\/live-edge\/[\w\-]+\/playlist\.m3u8)/i);

    if (streamData !== null) {
      cmdargs.url = streamData[1];
    } else {
      printErrorMsg(CB, nm + ' is offline');
    }

    return cmdargs;
  })
  .catch(function(err) {
    printErrorMsg(CB, colors.model(nm) + ': ' + err.toString());
  });
}

function createCbCaptureProcess(nm) {
  if (cbModelsCurrentlyCapturing.indexOf(nm) != -1) {
    printDebugMsg(CB, colors.model(nm) + ' is already capturing');
    return; // resolve immediately
  }

  if (tryingToExit) {
    printDebugMsg(CB, colors.model(nm) + ' is now online, but capture not started due to ctrl+c');
    return;
  }

  printMsg(CB, colors.model(nm) + ' is now online, starting capturing process');

  return Promise.try(function() {
    return getCbStream(nm);
  }).then(function (cmdargs) {
    var filename = getFileName(CB, cmdargs.nm);
    cbFilesCurrentlyCapturing.push(filename);

    var spawnArgs = getCaptureArguments(cmdargs.url, filename);

    startCapture(CB, spawnArgs, filename, cmdargs.nm);
  })
  .catch(function(err) {
    printErrorMsg(CB, colors.model(nm) + ' ' + err.toString());
  });
}

function getIfStreams(nm) {
  return Promise.try(function() {
    //http://www.ifriends.net/membrg/showclub_v2_custom.dll?pclub=DAWNSPLACE&pStyle=Home
    return session.get('http://www.ifriends.net/membrg/showclub_v2_custom.dll?pclub=' + nm + '&pStyle=Home');
  }).then(function (response) {
    var $ = cheerio.load(response.body);

    // Get the SessionID
    var sessionID = $('input[name="f_hid_SessionID_ExSignIn"]').attr('value');

    // TODO: Don't currently know how to automatically discover the correct
    //       stream server.  For now, ffmpeg is launched for all four servers
    //       and 3 of the jobs will die.
    var commands = [];
    for (var i = 1; i <= 4; i++) {
      var cmdargs = {
        nm: nm,
      };

      cmdargs.url = 'http://STREAM0' + i + '.ifriends.net:1935/LSFlashVCH/' + nm + '/' + nm + sessionID + '/playlist.m3u8';
      commands.push(cmdargs);
    }
    return commands;
  })
  .catch(function(err) {
    printErrorMsg(IF, colors.model(nm) + ': ' + err.toString());
  });
}

function createIfCaptureProcess(nm) {
  if (ifModelsCurrentlyCapturing.indexOf(nm) != -1) {
    printDebugMsg(IF, colors.model(nm) + ' is already capturing');
    return; // resolve immediately
  }

  if (tryingToExit) {
    printDebugMsg(IF, colors.model(nm) + ' is now online, but capture not started due to ctrl+c');
    return;
  }

  printMsg(IF, colors.model(nm) + ' is now online, starting capturing process');

  return Promise.try(function() {
    return getIfStreams(nm);
  }).then(function (commands) {
    for (var i = 0; i < commands.length; i++) {
      var filename = getFileName(IF, commands[i].nm) + '_' + (i+1);
      ifFilesCurrentlyCapturing.push(filename);

      var spawnArgs = getCaptureArguments(commands[i].url, filename);

      startCapture(IF, spawnArgs, filename, commands[i].nm);
    }
  })
  .catch(function(err) {
    printErrorMsg(IF, colors.model(nm) + ' ' + err.toString());
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
    printMsg('', data);
  });

  myCompleteProcess.stderr.on('data', function(data) {
    printMsg('', data);
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

  myCompleteProcess.on('error', function(err) {
    printErrorMsg('', err);
  });
}

function mainSiteLoop(site) {
  printDebugMsg(site, 'Start searching for new models');

  Promise.try(function() {
    return getOnlineModels(site);
  })
  .then(function(onlineModels) {
    printMsg(site, onlineModels.length  + ' model(s) online');
    return selectMyModels(site, onlineModels);
  })
  .then(function(myModels) {
    if (myModels != null) {
      if (myModels.length > 0) {
        printDebugMsg(site, myModels.length + ' model(s) to capture');
        switch (site) {
          case MFC: return Promise.all(myModels.map(createMfcCaptureProcess));   break;
          case CB:  return Promise.all(myModels.map(createCbCaptureProcess));    break;
          case IF:  return Promise.all(myModels.map(createIfCaptureProcess));    break;
        }
      } else {
        return;
      }
    } else {
      return;
    }
  })
  .catch(function(err) {
    printErrorMsg(site, err);
  })
  .finally(function() {
    printMsg(site, 'Done, will search for new models in ' + config.modelScanInterval + ' second(s).');
    setTimeout(function() { mainSiteLoop(site) }, config.modelScanInterval * 1000);
  });
}

var semaphore = 0; // Counting semaphore
var tryingToExit = 0;
var mfcGuest;
var myMfcModels = [];
var mfcModelsCurrentlyCapturing = new Array();
var mfcFilesCurrentlyCapturing  = new Array();
var cbModelsCurrentlyCapturing  = new Array();
var cbFilesCurrentlyCapturing   = new Array();
var ifModelsCurrentlyCapturing  = new Array();
var ifModelCapCount             = new Array();
var ifFilesCurrentlyCapturing   = new Array();

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
  if (semaphore == 0 && mfcFilesCurrentlyCapturing.length == 0 && cbFilesCurrentlyCapturing.length == 0 && ifFilesCurrentlyCapturing.length == 0) {
    process.stdout.write('\n');
    if (config.enableMFC) {
      mfcGuest.disconnect();
    }
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
    if (semaphore > 0 || mfcFilesCurrentlyCapturing.length > 0 || cbFilesCurrentlyCapturing.length > 0 || ifFilesCurrentlyCapturing.length > 0) {
      var capsInProgress = mfcFilesCurrentlyCapturing.length + cbFilesCurrentlyCapturing.length + ifFilesCurrentlyCapturing.length;
      // extra newline to avoid ^C
      process.stdout.write('\n');
      printMsg('', 'Waiting for ' + capsInProgress + ' capture stream(s) to end.');
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
    mainSiteLoop(MFC);
  }).catch(function(err) {
    printErrorMsg(MFC, err);
  });
}

if (config.enableCB) {
  mainSiteLoop(CB);
}

if (config.enableIF) {
  mainSiteLoop(IF);
}

