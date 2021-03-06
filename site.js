const yaml         = require("js-yaml");
const mkdirp       = require("mkdirp");
const fs           = require("fs");
const mv           = require("mv");
const moment       = require("moment");
const colors       = require("colors/safe");
const childProcess = require("child_process");
const blessed      = require("blessed");

class Site {
    constructor(siteName, config, siteDir, screen, logbody, num) {
        this.semaphore = 0;
        this.siteName = siteName;
        this.config = config;

        this.modelsToCap = [];
        this.modelState = new Map();
        this.currentlyCapping = new Map();
        this.siteDir = siteDir;
        this.screen = screen;
        this.logbody = logbody;

        this.modelList = new Map();

        this.title = blessed.box({
            top: 0,
            left: num === 2 ? "50%" : 0,
            height: 1,
            width: "50%",
            keys: false,
            mouse: false,
            alwaysScroll: false,
            scrollable: false
        });

        this.list = blessed.box({
            top: 1,
            left: num === 2 ? "50%" : 0,
            height: "66%-1",
            width: "50%",
            keys: true,
            mouse: true,
            alwaysScroll: true,
            scrollable: true,
            draggable: false,
            shadow: false,
            scrollbar: {
                ch: " ",
                bg: "red"
            },
            border : {
                type: "line",
                fg: "blue"
            }
        });

        screen.append(this.title);
        screen.append(this.list);

        this.title.pushLine(colors.site(this.siteName));
    }

    hide() {
        this.title.hide();
        this.list.hide();
    }

    show() {
        this.title.show();
        this.list.show();
    }

    full() {
        this.list.height = "100%-2";
    }

    restore() {
        this.list.height = "66%-1";
    }

    getSiteName() {
        return this.siteName;
    }

    getDateTime() {
        return moment().format(this.config.dateFormat);
    }

    getFileName(nm) {
        let filename = nm + "_";

        if (this.config.includeSiteInFile) {
            filename += this.siteName.trim().toLowerCase() + "_";
        }
        filename += this.getDateTime();
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

    addModel(model, models) {
        const index = models.indexOf(model.uid);
        let rc = false;
        if (index === -1) {
            this.msg(colors.model(model.nm) + colors.italic(" added") + " to capture list");
            rc = true;
        } else {
            this.msg(colors.model(model.nm) + " is already in the capture list");
        }
        if (!this.modelList.has(model.nm)) {
            this.modelList.set(model.nm, {uid: model.uid, nm: model.nm, modelState: "Offline", filename: ""});
        }
        this.render();
        return rc;
    }

    removeModel(model) {
        this.msg(colors.model(model.nm) + colors.italic(" removed") + " from capture list.");
        if (this.modelList.has(model.nm)) {
            this.modelList.delete(model.nm);
        }
        this.render();
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

    haltAllCaptures() {
        this.msg("aborting");
        this.currentlyCapping.forEach(function(value) {
            value.captureProcess.kill("SIGINT");
        });
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

        const listitem = this.modelList.get(model.nm);
        listitem.filename = filename + ".ts";
        this.modelList.set(model.nm, listitem);

        captureProcess.on("close", function() {
            if (tryingToExit) {
                me.msg(colors.model(model.nm) + " capture interrupted");
            }

            const li = me.modelList.get(model.nm);
            li.filename = "";
            me.modelList.set(model.nm, li);

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
            this.render();
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
        const listitem = this.modelList.get(model.nm);
        listitem.filename = filename + "." + this.config.autoConvertType;
        this.modelList.set(model.nm, listitem);
        this.render();

        myCompleteProcess.on("close", function() {
            if (!me.config.keepTsFile) {
                fs.unlinkSync(me.config.captureDirectory + "/" + filename + ".ts");
            }
            me.msg(colors.model(model.nm) + " done converting " + filename + "." + me.config.autoConvertType);
            const li = me.modelList.get(model.nm);
            li.filename = "";
            me.modelList.set(model.nm, li);
            me.render();
            me.semaphore--; // release semaphore only when ffmpeg process has ended
        });

        myCompleteProcess.on("error", function(err) {
            me.errMsg(err);
        });
    }

    msg(msg) {
        this.logbody.pushLine(colors.time("[" + this.getDateTime() + "]") + " " + colors.site(this.siteName) + " " + msg);
        this.logbody.setScrollPerc(100);
        this.screen.render();
    }

    errMsg(msg) {
        this.msg(colors.error("[ERROR] ") + msg);
    }

    dbgMsg(msg) {
        if (this.config.debug) {
            this.msg(colors.debug("[DEBUG] ") + msg);
        }
    }

    render() {
        const me = this;

        // TODO: Hack
        for (let i = 0; i < 100; i++) {
            me.list.deleteLine(0);
        }

        const sortedKeys = Array.from(this.modelList.keys()).sort();
        for (let i = 0; i < sortedKeys.length; i++) {
            const value = this.modelList.get(sortedKeys[i]);
            let line = colors.model(value.nm);
            for (let j = 0; j < 16 - value.nm.length; j++) {
                line += " ";
            }
            line += value.modelState ===  "Offline" ? colors.offline(value.modelState) : colors.state(value.modelState);
            for (let j = 0; j < 16 - value.modelState.length; j++) {
                line += " ";
            }
            line += colors.file(value.filename);
            this.list.pushLine(line);
        }
        this.screen.render();
    }
}

exports.Site = Site;

