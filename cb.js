const Promise = require("bluebird");
const colors  = require("colors/safe");
const bhttp   = require("bhttp");
const cheerio = require("cheerio");
const _       = require("underscore");
const fs      = require("fs");
const yaml    = require("js-yaml");
const site    = require("./site");

class Cb extends site.Site {
    constructor(config, screen, logbody, body) {
        super("CB ", config, "_cb", screen, logbody, body);
        this.onlineModels = new Map();
        this.timeOut = 20000;
        this.session = bhttp.session();
    }

    findOnlineModels() {
        const me = this;

        return Promise.try(function() {
            return bhttp.get("https://chaturbate.com/tours/3/?c=10000", {responseTimeout: me.timeOut});
        }).then(function(response) {

            const $ = cheerio.load(response.body);

            $("ul.list li").each(function(i, li) {
                const cs = $(li).find("div.thumbnail_label");
                const modelname = $(li).find("div.title a").text().trim();
                let currState = "away";

                if (cs.hasClass("thumbnail_label_c_hd") || cs.hasClass("thumbnail_label_c_new") ||
                    cs.hasClass("thumbnail_label_exhibitionist") || cs.hasClass("thumbnail_label_c")) {
                    currState = "public";
                } else if (cs.hasClass("thumbnail_label_c_private_show")) {
                    currState = "private";
                } else if (cs.hasClass("thumbnail_label_c_group_show")) {
                    currState = "group";
                } else if (cs.hasClass("thumbnail_label_c_hidden_show")) {
                    currState = "hidden";
                } else if (cs.hasClass("thumbnail_label_offline")) {
                    currState = "away";
                }

                me.onlineModels.set(modelname, currState);
            });
        }).catch(function(err) {
            if (err !== null && err.code === 607) {
                me.errMsg("CB did not respond after " + (me.timeOut / 1000) + " seconds.");
            } else {
                me.errMsg(err.toString());
            }
        });
    }

    getStream(nm) {
        const me = this;

        return Promise.try(function() {
            return me.session.get("https://chaturbate.com/" + nm + "/");
        }).then(function(response) {
            let url = "";
            const page = cheerio.load(response.body);
            const scripts = page("script").map(function() {
                return page(this).text();
            }).get().join("");

            let streamData = scripts.match(/(https:\/\/\w+\.stream\.highwebmedia\.com\/live-edge\/[\w-]+\/playlist\.m3u8)/i);

            if (streamData !== null) {
                url = streamData[1];
            } else {
                streamData = scripts.match(/(https:\/\/\w+\.stream\.highwebmedia\.com\/live-edge\/amlst:[\w-]+\/playlist\.m3u8)/i);
                if (streamData !== null) {
                    url = streamData[1];
                } else {
                    // CB's JSON for online models does not update quickly when a model
                    // logs off, and the JSON can take up to 30 minutes to update.
                    // When a model is offline, the models page redirect to a login
                    // page and there won't be a match for the m3u8 regex.
                    // Temporarily commenting out the error, until a better solution
                    // is coded.
                    // me.errMsg(me, nm + ", failed to find m3u8 stream");
                }
            }

            // me.dbgMsg(me, "url = " + url);
            return url;
        }).catch(function(err) {
            me.errMsg(colors.model(nm) + ": " + err.toString());
            return err;
        });
    }

    processUpdates() {
        const stats = fs.statSync("updates.yml");

        let includeModels = [];
        let excludeModels = [];

        if (stats.isFile()) {
            const updates = yaml.safeLoad(fs.readFileSync("updates.yml", "utf8"));

            if (!updates.includeCbModels) {
                updates.includeCbModels = [];
            } else if (updates.includeCbModels.length > 0) {
                this.msg(updates.includeCbModels.length + " model(s) to include");
                includeModels = updates.includeCbModels;
                updates.includeCbModels = [];
            }

            if (!updates.excludeCbModels) {
                updates.excludeCbModels = [];
            } else if (updates.excludeCbModels.length > 0) {
                this.msg(updates.excludeCbModels.length + " model(s) to exclude");
                excludeModels = updates.excludeCbModels;
                updates.excludeCbModels = [];
            }

            // if there were some updates, then rewrite updates.yml
            if (includeModels.length > 0 || excludeModels.length > 0) {
                fs.writeFileSync("updates.yml", yaml.safeDump(updates), "utf8");
            }
        }

        return {includeModels: includeModels, excludeModels: excludeModels, dirty: false};
    }

    addModel(model) {
        if (super.addModel(model.uid, model.nm, this.config.cbmodels)) {
            this.config.cbmodels.push(model.uid);
            return true;
        }
        return false;
    }

    addModels(bundle) {
        for (let i = 0; i < bundle.includeModels.length; i++) {
            bundle.dirty |= this.addModel({nm: bundle.includeModels[i], uid: bundle.includeModels[i]});
        }
        return bundle;
    }

    removeModel(model) {
        this.config.cbmodels = _.without(this.config.cbmodels, model.uid);
        return super.removeModel(model);
    }

    removeModels(bundle) {
        for (let i = 0; i < bundle.excludeModels.length; i++) {
            const nm = bundle.excludeModels[i];
            const index = this.config.cbmodels.indexOf(nm);

            if (index !== -1) {
                bundle.dirty |= this.removeModel({nm: nm, uid: nm});
            }
        }
        return bundle.dirty;
    }

    checkModelState(nm) {
        let msg = colors.model(nm);
        let isBroadcasting = 0;

        if (this.onlineModels.has(nm)) {
            const currState = this.onlineModels.get(nm);

            if (currState === "public") {
                msg += " is in public chat!";
                this.modelsToCap.push({uid: nm, nm: nm});
                this.render();
                isBroadcasting = 1;
            } else if (currState === "private") {
                msg += " is in a private show.";
            } else if (currState === "group") {
                msg += " is in a group show.";
            } else if (currState === "away") {
                msg += colors.model("'s") + " cam is off.";
            } else if (currState === "hidden") {
                msg += " model is online but hidden.";
            } else {
                msg += " has unknown state " + currState;
            }
            if (!this.modelState.has(nm) || (this.modelState.has(nm) && currState !== this.modelState.get(nm))) {
                this.msg(msg);
            }
            this.modelState.set(nm, currState);
        } else if (this.modelState.has(nm) && this.modelState.get(nm) !== "offline") {
            msg += " has logged off.";
        } else {
            this.modelState.set(nm, "offline");
        }

        if (this.currentlyCapping.has(nm) && isBroadcasting === 0) {
            this.dbgMsg(colors.model(nm) + " is not broadcasting, but ffmpeg is still active. Terminating with SIGINT.");
            this.haltCapture(nm);
        }

        return Promise.try(function() {
            return true;
        });
    }

    getModelsToCap() {
        const me = this;

        this.modelsToCap = [];

        return Promise.try(function() {
            return me.findOnlineModels();
        }).then(function() {
            const queries = [];

            for (let i = 0; i < me.config.cbmodels.length; i++) {
                queries.push(me.checkModelState(me.config.cbmodels[i]));
            }

            return Promise.all(queries).then(function() {
                return me.modelsToCap;
            });
        });
    }

    setupCapture(model, tryingToExit) {
        const me = this;

        if (!super.setupCapture(model, tryingToExit)) {
            return Promise.try(function() {
                return {spawnArgs: "", filename: "", model: ""};
            });
        }

        return Promise.try(function() {
            return me.getStream(model.nm);
        }).then(function(url) {
            const filename = me.getFileName(model.nm);
            let spawnArgs = me.getCaptureArguments(url, filename);

            if (url === "") {
                me.msg(colors.model(model.nm) + " is not actually online, CB is not updating properly.");
                spawnArgs = "";
            }
            return {spawnArgs: spawnArgs, filename: filename, model: model};
        }).catch(function(err) {
            me.errMsg(colors.model(model.nm) + " " + err.toString());
            return err;
        });
    }

    recordModels(modelsToCap, tryingToExit) {
        if (modelsToCap !== null && modelsToCap.length > 0) {
            const caps = [];
            const me = this;

            this.dbgMsg(modelsToCap.length + " model(s) to capture");
            for (let i = 0; i < modelsToCap.length; i++) {
                const cap = this.setupCapture(modelsToCap[i], tryingToExit).then(function(bundle) {
                    if (bundle.spawnArgs !== "") {
                        me.startCapture(bundle.spawnArgs, bundle.filename, bundle.model, tryingToExit);
                    }
                });
                caps.push(cap);
            }
            return Promise.all(caps);
        }
        return null;
    }
}

exports.Cb = Cb;

