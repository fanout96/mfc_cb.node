'use strict';
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

function getMfcFileno() {
  return new Promise(function(resolve, reject) {
    var client = new WebSocketClient();

    client.on('connectFailed', function(err) {
      reject(err);
    });

    client.on('connect', function(connection) {

      connection.on('error', function(err) {
        reject(err);
      });

      connection.on('message', function(message) {
        if (message.type === 'utf8') {
          var parts = /\{%22fileno%22:%22([0-9_]*)%22\}/.exec(message.utf8Data);

          if (parts && parts[1]) {
            // printDebugMsg('MFC', 'fileno = ' + parts[0]);

            connection.close();
            resolve(parts[1]);
          }
        }
      });

      connection.sendUTF("hello fcserver\n\0");
      connection.sendUTF("1 0 0 20071025 0 guest:guest\n\0");
    });

    client.connect('ws://xchat20.myfreecams.com:8080/fcsl', '', 'http://xchat20.myfreecams.com:8080', {Cookie: ''});
  }).timeout(30000); // 30 secs
}

function getMfcOnlineModels(fileno) {

  if (config.mfcmodels.length == 0) {
    printMsg('MFC', 'No models in config.yml. Skipping.');
    return;
  }

  return new Promise(function(resolve, reject) {
    var url = 'http://www.myfreecams.com/mfc2/php/mobj.php?f=' + fileno + '&s=xchat20';

    // printDebugMsg('MFC', url);

    http
      .get(url, function(response) {
        var rawHTML = '';

        if (response.statusCode == 200) {
          response.on('data', function(data) {
            rawHTML += data;
          });

          response.on('end', function() {
            try {
              rawHTML = rawHTML.toString('utf8');
              rawHTML = rawHTML.substring(rawHTML.indexOf('{'), rawHTML.indexOf("\n") - 1);
              rawHTML = rawHTML.replace(/[^\x20-\x7E]+/g, '');

              var data = JSON.parse(rawHTML);

              var onlineModels = [];

              for (var key in data) {
                if (data.hasOwnProperty(key) && typeof data[key].nm != 'undefined' && typeof data[key].uid != 'undefined') {
                  onlineModels.push({
                    nm: data[key].nm,
                    uid: data[key].uid,
                    vs: data[key].vs,
                    camserv: data[key].u.camserv,
                    camscore: data[key].m.camscore,
                    new_model: data[key].m.new_model
                  });
                }
              }

              printMsg('MFC', onlineModels.length  + ' model(s) online');

              resolve(onlineModels);
            } catch (err) {
              reject(err);
            }
          });
        } else {
          reject('Invalid response: ' + response.statusCode);
        }
      })
      .on('error', function(err) {
        reject(err);
      });
  }).timeout(30000); // 30 secs
}

function getCbOnlineModels(page) {

  if (config.cbmodels.length == 0) {
    printMsg('CB ', 'No models in config.yml. Skipping.');
    return;
  }

  // TODO: Replace followed-cams with https://chaturbate.com/feed/latest/
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
  });
}

function selectMfcMyModels(onlineModels) {
  if (onlineModels == null) {
    return;
  }

  return Promise
    .try(function() {
      printDebugMsg('MFC', config.mfcmodels.length + ' model(s) in config');

      var dirty = false;
      var stats = fs.statSync('updates.yml');

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

          config.includeMfcModels = _.union(config.includeMfcModels, updates.includeMfcModels);
          dirty = true;
        }

        if (updates.excludeMfcModels.length > 0) {
          printMsg('MFC', updates.excludeMfcModels.length + ' model(s) to exclude');

          config.excludeMfcModels = _.union(config.excludeMfcModels, updates.excludeMfcModels);
          dirty = true;
        }

        // if there were some updates, then we reset updates.yml
        if (dirty) {
          updates.includeMfcModels = [];
          updates.excludeMfcModels = [];

          fs.writeFileSync('updates.yml', yaml.safeDump(updates), 0, 'utf8');
        }
      }

      config.includeMfcModels = _.reject(config.includeMfcModels, function(nm) {
        // if we managed to find id of the model in the collection of online models
        // we add her id in models and remove he from includeMfcModels
        var model = _.findWhere(onlineModels, {nm: nm});

        if (!model) {
          return false;
        } else {
          config.mfcmodels.push(model.uid);
          dirty = true;
          return true;
        }
      });

      config.excludeMfcModels = _.reject(config.excludeMfcModels, function(nm) {
        // if we managed to find id of the model in the collection of online models
        // we remove her id in models and remove her from excludeMfcModels
        var model = _.findWhere(onlineModels, {nm: nm});

        if (!model) {
          return false;
        } else {
          config.mfcmodels = _.without(config.mfcmodels, model.uid);
          dirty = true;
          return true;
        }
      });

      if (dirty) {
        fs.writeFileSync('config.yml', yaml.safeDump(config), 0, 'utf8');
      }

      var myModels = [];

      _.each(config.mfcmodels, function(uid) {
        var model = _.findWhere(onlineModels, {uid: uid});

        if (model) {
          if (model.vs === 0) {
            myModels.push(model);
          } else {
            printMsg('MFC', colors.model(model.nm) + ' is away or in a private');
          }
        }
      });

      printDebugMsg('MFC', myModels.length  + ' model(s) to capture');

      return myModels;
    });
}

function selectCbMyModels(onlineModels) {
  if (onlineModels == null) {
    return;
  }

  printMsg('CB ', onlineModels.length  + ' model(s) online');

  return Promise
    .try(function() {
      printDebugMsg('CB ', config.cbmodels.length + ' model(s) in config');

      var dirty = false;
      var stats = fs.statSync('updates.yml');

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

          config.includeCbModels = _.union(config.includeCbModels, updates.includeCbModels);
          dirty = true;
        }

        if (updates.excludeCbModels.length > 0) {
          printMsg('CB ', updates.excludeCbModels.length + ' model(s) to exclude');

          config.excludeCbModels = _.union(config.excludeCbModels, updates.excludeCbModels);
          dirty = true;
        }

        // if there were some updates, then we reset updates.yml
        if (dirty) {
          updates.includeCbModels = [];
          updates.excludeCbModels = [];

          fs.writeFileSync('updates.yml', yaml.safeDump(updates), 0, 'utf8');
        }
      }

      config.includeCbModels = _.reject(config.includeCbModels, function(nm) {
        // if we managed to find name of model in the collection of online models
        // we add her name in models and remove he from includeCbModels
        var modelIndex = onlineModels.indexOf(nm);

        if (modelIndex !== -1) {
          config.cbmodels.push(nm);
          dirty = true;
          return true;
        } else {
          return false;
        }
      });

      config.excludeCbModels = _.reject(config.excludeCbModels, function(nm) {
        // if we managed to find id of the model in the collection of online models
        // we remove her id in models and remove her from excludeCbModels
        var modelIndex = onlineModels.indexOf(nm);

        if (modelIndex !== 1) {
          config.cbmodels = _.without(config.cbmodels, nm);
          dirty = true;
          return true;
        } else {
          return false;
        }
      });

      if (dirty) {
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
    });
}

function createMfcCaptureProcess(model) {
  if (mfcModelsCurrentlyCapturing.indexOf(model.uid) != -1) {
    printDebugMsg('MFC', colors.model(model.nm) + ' is already capturing');
    return; // resolve immediately
  }

  if (tryingToExit) {
    printDebugMsg('MFC', model.nm + ' is now online, but capture not started due to ctrl+c');
    return;
  }

  printMsg('MFC', colors.model(model.nm) + ' is now online, starting capturing process');

  return Promise
    .try(function() {
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
        'http://video' + (model.camserv - 500) + '.myfreecams.com:1935/NxServer/ngrp:mfc_' + (100000000 + model.uid) + '.f4v_mobile/playlist.m3u8',
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
          process.stdout.write(colors.site('MFC') + ' ' + colors.model(model.nm) + ' capture interrupted\n');
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

  return Promise
    .try(function() {
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
          process.stdout.write(colors.site('CB ') + ' ' + colors.model(commandArguments.modelName) + ' capture interrupted\n');
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
  printDebugMsg('', 'Converting ' + filename + '.ts to ' + filename + '.' + config.autoConvertType);
  if (tryingToExit) {
    process.stdout.write(colors.time('[' + getCurrentDateTime() + '] ')); // log beautification
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
    semaphore--; // release semaphore only when ffmpeg process has ended
  });
}

function mainMfcLoop() {
  printDebugMsg('MFC', 'Start searching for new models');

  Promise
    .try(function() {
      return getMfcFileno();
    })
    .then(function(fileno) {
      return getMfcOnlineModels(fileno);
    })
    .then(function(onlineModels) {
      return selectMfcMyModels(onlineModels);
    })
    .then(function(myModels) {
      if (myModels != null) {
        return Promise.all(myModels.map(createMfcCaptureProcess));
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

  Promise
    .try(function() {
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
  // for all models has finished.  Keep checking every 1s
  if (semaphore == 0 && mfcFilesCurrentlyCapturing.length == 0 && cbFilesCurrentlyCapturing.length == 0) {
    process.stdout.write('\n');
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

mainMfcLoop();
mainCbLoop();
