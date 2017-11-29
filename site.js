const yaml         = require("js-yaml");
const mkdirp       = require("mkdirp");
const fs           = require("fs");
const mv           = require("mv");
const moment       = require("moment");
const colors       = require("colors/safe");
const childProcess = require("child_process");

class Site {
    constructor(siteName, config, siteDir) {
        this.semaphore = 0;
        this.siteName = siteName;
        this.config = config;

        this.modelsToCap = [];
        this.modelState = new Map();
        this.currentlyCapping = new Map();
        this.siteDir = siteDir;
    }

    getSiteName() {
        return this.siteName;
    }

    getDateTime() {
        return moment().format(this.config.dateFormat);
    }

    getFileName(nm) {
        let filename;

        if (this.config.includeSiteInFile) {
            filename = nm + "_" + this.siteName.trim().toLowerCase() + "_" + this.getDateTime();
        } else {
            filename = nm + "_" + this.getDateTime();
        }
        return filename;
    }

    checkFileSize() {
        const maxByteSize = this.config.maxByteSize;

        if (maxByteSize > 0) {
            for (const capInfo of this.currentlyCapping.values()) {
                const stat = fs.statSync(this.config.captureDirectory + "/" + capInfo.filename + ".ts");
                this.dbgMsg(colors.model(capInfo.nm) + " file size (" + capInfo.filename + ".ts), size=" + stat.size + ", maxByteSize=" + maxByteSize);
                if (stat.size >= maxByteSize) {
                    this.msg(colors.model(capInfo.nm) + " recording has exceeded file size limit (size=" + stat.size + " > maxByteSize=" + maxByteSize + ")");
                    capInfo.captureProcess.kill("SIGINT");
                }
            }
        }
    }

    getCaptureArguments(url, filename) {
        return [
            "-hide_banner",
            "-v",
            "fatal",
            "-i",
            url,
            "-c",
            "copy",
            "-vsync",
            "2",
            "-r",
            "60",
            "-b:v",
            "500k",
            this.config.captureDirectory + "/" + filename + ".ts"
        ];
    }

    addModel(uid, nm, models) {
        const index = models.indexOf(uid);
        let rc = false;
        if (index === -1) {
            this.msg(colors.model(nm) + colors.italic(" added") + " to capture list");
            rc = true;
        } else {
            this.msg(colors.model(nm) + " is already in the capture list");
        }
        return rc;
    }

    removeModel(model) {
        this.msg(colors.model(model.nm) + colors.italic(" removed") + " from capture list.");
        this.haltCapture(model);
        return true;
    }

    addModelToCapList(model, filename, captureProcess) {
        this.currentlyCapping.set(model.uid, {nm: model.nm, filename: filename, captureProcess: captureProcess});
    }

    removeModelFromCapList(model) {
        this.currentlyCapping.delete(model.uid);
    }

    getNumCapsInProgress() {
        return this.currentlyCapping.size;
    }

    haltCapture(index) {
        if (this.currentlyCapping.has(index)) {
            const capInfo = this.currentlyCapping.get(index);

            capInfo.captureProcess.kill("SIGINT");
        }
    }

    writeConfig(dirty) {
        if (dirty) {
            this.dbgMsg("Rewriting config.yml");
            fs.writeFileSync("config.yml", yaml.safeDump(this.config), "utf8");
        }
    }

    setupCapture(model, tryingToExit) {
        if (this.currentlyCapping.has(model.uid)) {
            this.dbgMsg(colors.model(model.nm) + " is already capturing");
            return false;
        }

        if (tryingToExit) {
            this.dbgMsg(colors.model(model.nm) + " capture not starting due to ctrl+c");
            return false;
        }

        return true;
    }

    startCapture(spawnArgs, filename, model, tryingToExit) {
        const me = this;
        const captureProcess = childProcess.spawn("ffmpeg", spawnArgs);

        captureProcess.on("close", function() {
            if (tryingToExit) {
                me.msg(colors.model(model.nm) + " capture interrupted");
            }

            me.removeModelFromCapList(model);

            fs.stat(me.config.captureDirectory + "/" + filename + ".ts", function(err, stats) {
                if (err) {
                    if (err.code === "ENOENT") {
                        me.errMsg(colors.model(model.nm) + ", " + filename + ".ts not found in capturing directory, cannot convert to " + me.config.autoConvertType);
                    } else {
                        me.errMsg(colors.model(model.nm) + ": " + err.toString());
                    }
                } else if (stats.size <= me.config.minByteSize) {
                    me.msg(colors.model(model.nm) + " recording automatically deleted (size=" + stats.size + " < minSizeBytes=" + me.config.minByteSize + ")");
                    fs.unlinkSync(me.config.captureDirectory + "/" + filename + ".ts");
                } else {
                    me.postProcess(filename, model);
                }
            });
        });

        if (captureProcess.pid) {
            this.msg(colors.model(model.nm) + " recording started (" + filename + ".ts)");
            this.addModelToCapList(model, filename, captureProcess);
        }
    }

    postProcess(filename, model) {
        const me = this;
        let modelDir = this.config.completeDirectory;
        let mySpawnArguments;

        if (this.config.modelSubdir) {
            modelDir = modelDir + "/" + model.nm;
            if (this.config.includeSiteInDir) {
                modelDir += this.siteDir;
            }
            mkdirp.sync(modelDir);
        }

        if (this.config.autoConvertType !== "mp4" && this.config.autoConvertType !== "mkv") {
            this.dbgMsg(colors.model(model.nm) + " recording moved (" + this.config.captureDirectory + "/" + filename + ".ts to " + modelDir + "/" + filename + ".ts)");
            mv(this.config.captureDirectory + "/" + filename + ".ts", modelDir + "/" + filename + ".ts", function(err) {
                if (err) {
                    me.errMsg(colors.site(filename) + ": " + err.toString());
                }
            });
            return;
        }

        if (this.config.autoConvertType === "mp4") {
            mySpawnArguments = [
                "-hide_banner",
                "-v",
                "fatal",
                "-i",
                this.config.captureDirectory + "/" + filename + ".ts",
                "-c",
                "copy",
                "-bsf:a",
                "aac_adtstoasc",
                "-copyts",
                modelDir + "/" + filename + "." + this.config.autoConvertType
            ];
        } else if (this.config.autoConvertType === "mkv") {
            mySpawnArguments = [
                "-hide_banner",
                "-v",
                "fatal",
                "-i",
                this.config.captureDirectory + "/" + filename + ".ts",
                "-c",
                "copy",
                "-copyts",
                modelDir + "/" + filename + "." + this.config.autoConvertType
            ];
        }

        this.semaphore++;

        this.msg(colors.model(model.nm) + " converting to " + filename + "." + this.config.autoConvertType);

        const myCompleteProcess = childProcess.spawn("ffmpeg", mySpawnArguments);

        myCompleteProcess.on("close", function() {
            if (!me.config.keepTsFile) {
                fs.unlinkSync(me.config.captureDirectory + "/" + filename + ".ts");
            }
            me.msg(colors.model(model.nm) + " done converting " + filename + "." + me.config.autoConvertType);
            me.semaphore--; // release semaphore only when ffmpeg process has ended
        });

        myCompleteProcess.on("error", function(err) {
            me.errMsg(err);
        });
    }

    msg(msg) {
        console.log(colors.time("[" + this.getDateTime() + "]"), colors.site(this.siteName), msg);
    }

    errMsg(msg) {
        this.msg(colors.error("[ERROR] ") + msg);
    }

    dbgMsg(msg) {
        if (this.config.debug) {
            this.msg(colors.debug("[DEBUG] ") + msg);
        }
    }
}

exports.Site = Site;

