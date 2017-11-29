"use strict";

require("events").EventEmitter.prototype._maxListeners = 100;

// 3rd Party Libraries
const Promise    = require("bluebird");
const fs         = require("fs");
const yaml       = require("js-yaml");
const mkdirp     = require("mkdirp");
const colors     = require("colors/safe");
const path       = require("path");

// local libraries
const MFC        = require("./mfc");
const CB         = require("./cb");

let tryingToExit = 0;
const config     = yaml.safeLoad(fs.readFileSync("config.yml", "utf8"));

let mfc;
let cb;
const SITES = [];

function sleep(time) {
    return new Promise((resolve) => setTimeout(resolve, time));
}

function mainSiteLoop(site) {

    Promise.try(function() {
        site.checkFileSize(config.captureDirectory, config.maxByteSize);
    }).then(function() {
        return site.processUpdates();
    }).then(function(bundle) {
        return site.addModels(bundle);
    }).then(function(bundle) {
        return site.removeModels(bundle);
    }).then(function(dirty) {
        return site.writeConfig(dirty);
    }).then(function() {
        return site.getModelsToCap();
    }).then(function(modelsToCap) {
        return site.recordModels(modelsToCap, tryingToExit);
    }).catch(function(err) {
        site.errMsg(err);
    }).finally(function() {
        site.dbgMsg("Done, waiting " + config.modelScanInterval + " seconds.");
        setTimeout(function() { mainSiteLoop(site); }, config.modelScanInterval * 1000);
    });
}

function busy() {
    let capsInProgress = 0;
    let semaphore = 0;

    for (let i = 0; i < SITES.length; i++) {
        capsInProgress += SITES[i].getNumCapsInProgress();
        semaphore      += SITES[i].semaphore;
    }
    return semaphore > 0 || capsInProgress > 0;
}

function tryExit() {
    // SIGINT will get passed to any running ffmpeg captures.
    // Must delay exiting until the capture and postProcess
    // for all models have finished.  Keep checking every 1s
    if (!busy()) {
        if (config.enableMFC) {
            mfc.disconnect();
        }
        process.exit(0);
    } else {
        sleep(1000).then(() => {
            tryExit(); // recursion!
        });
    }
}

process.on("SIGINT", function() {
    // Prevent bad things from happening if user holds down ctrl+c
    if (!tryingToExit) {
        tryingToExit = 1;
        if (busy()) {
            // extra newline to avoid ^C
            process.stdout.write("\n");
            console.log("Waiting for ffmpeg captures to terminate.");
        }
        tryExit();
    }
});

config.captureDirectory  = path.resolve(config.captureDirectory);
config.completeDirectory = path.resolve(config.completeDirectory);

mkdirp(config.captureDirectory, function(err) {
    if (err) {
        console.log(err.toString());
        process.exit(1);
    }
});

mkdirp(config.completeDirectory, function(err) {
    if (err) {
        console.log(err.toString());
        process.exit(1);
    }
});

colors.setTheme({
    model: config.modelcolor,
    time:  config.timecolor,
    site:  config.sitecolor,
    debug: config.debugcolor,
    error: config.errorcolor
});

if (config.enableMFC) {
    mfc = new MFC.Mfc(config);
    SITES.push(mfc);
    Promise.try(function() {
        return mfc.connect();
    }).then(function() {
        mfc.msg(config.mfcmodels.length + " model(s) in config");
        mainSiteLoop(mfc);
    }).catch(function(err) {
        mfc.errMsg(err);
    });
}

if (config.enableCB) {
    cb = new CB.Cb(config);
    SITES.push(cb);
    cb.msg(config.cbmodels.length + " model(s) in config");
    mainSiteLoop(cb);
}

