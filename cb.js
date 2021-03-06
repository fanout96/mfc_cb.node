const Promise = require("bluebird");
const colors  = require("colors/safe");
const fetch   = require("node-fetch");
const _       = require("underscore");
const fs      = require("fs");
const yaml    = require("js-yaml");
const site    = require("./site");

class Cb extends site.Site {
    constructor(config, screen, logbody, num) {
        super("CB ", config, "_cb", screen, logbody, num);
        this.cbData = new Map();
        this.timeOut = 20000;
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
        if (super.addModel(model, this.config.cbmodels)) {
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
        let url = "https://chaturbate.com/api/chatvideocontext/" + nm;
        let me = this;

        return Promise.try(function() {
            return fetch(url);
        }).then(function(res) {
            return res.json();
        }).then(function(json) {
            const listitem = me.modelList.get(nm);
            let currState;

            if (typeof json.status !== "undefined") {
                currState = "Access Denied";
                msg.dbgMsg(colors.model(nm) + ", " + json.detail);
            } else {
                currState = json.room_status;
                me.cbData.set(nm, json);
                if (currState === "public") {
                    msg += " is in public chat!";
                    me.modelsToCap.push({uid: nm, nm: nm});
                    isBroadcasting = 1;
                    listitem.modelState = "Public Chat";
                } else if (currState === "private") {
                    msg += " is in a private show.";
                    listitem.modelState = "Private";
                } else if (currState === "group") {
                    msg += " is in a group show.";
                    listitem.modelState = "Group Show";
                } else if (currState === "away") {
                    msg += colors.model("'s") + " cam is off.";
                    listitem.modelState = "Away";
                } else if (currState === "hidden") {
                    msg += " model is online but hidden.";
                    listitem.modelState = "Hidden";
                } else if (currState === "offline") {
                    msg += " model has gone offline.";
                    listitem.modelState = "Offline";
                } else {
                    msg += " has unknown state " + currState;
                    listitem.modelstate = currState;
                }
                me.modelList.set(nm, listitem);
                if ((!me.modelState.has(nm) && currState !== "offline") || (me.modelState.has(nm) && currState !== me.modelState.get(nm))) {
                    me.msg(msg);
                }
                me.modelState.set(nm, currState);
                me.render();

                if (me.currentlyCapping.has(nm) && isBroadcasting === 0) {
                    me.dbgMsg(colors.model(nm) + " is no longer broadcasting, ending ffmpeg process.");
                    me.haltCapture(nm);
                }
            }
            return true;
        }).catch(function(err) {
            me.errMsg("Unknown model " + colors.model(nm) + ", check the spelling.");
            me.modelList.delete(nm);
            me.render();
            return err;
        });
    }

    getModelsToCap() {
        const me = this;

        this.modelsToCap = [];

        // TODO: This should be somewhere else
        for (let i = 0; i < this.config.cbmodels.length; i++) {
            if (!this.modelList.has(this.config.cbmodels[i])) {
                this.modelList.set(this.config.cbmodels[i], {uid: this.config.cbmodels[i], nm: this.config.cbmodels[i], modelState: "Offline", filename: ""});
            }
        }
        this.render();

        const queries = [];

        me.modelList.forEach(function(value) {
            queries.push(me.checkModelState(value.nm));
        });

        return Promise.all(queries).then(function() {
            return me.modelsToCap;
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
            const filename = me.getFileName(model.nm);
            const data = me.cbData.get(model.nm);
            const url = data.hls_source;
            let spawnArgs = me.getCaptureArguments(url, filename);

            if (url === "") {
                me.msg(colors.model(model.nm) + " is not actually online, CB is not updating properly.");
                spawnArgs = "";
            }
            return {spawnArgs: spawnArgs, filename: filename, model: model};
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

