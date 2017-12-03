const Promise = require("bluebird");
const mfc     = require("MFCAuto");
const site    = require("./site");
const _       = require("underscore");
const fs      = require("fs");
const yaml    = require("js-yaml");
const colors  = require("colors/safe");

class Mfc extends site.Site {
    constructor(config, screen, logbody, num) {
        super("MFC", config, "_mfc", screen, logbody, num);
        mfc.setLogLevel(0);
        this.mfcGuest = new mfc.Client("guest", "guest", {useWebSockets: false, camYou: false});
    }

    connect() {
        const me = this;

        return Promise.try(function() {
            return me.mfcGuest.connectAndWaitForModels();
        }).catch(function(err) {
            me.errMsg(err.toString());
            return err;
        });
    }

    disconnect() {
        this.mfcGuest.disconnect();
    }

    queryUser(nm) {
        return this.mfcGuest.queryUser(nm);
    }

    processUpdates() {
        const stats = fs.statSync("updates.yml");

        let includeModels = [];
        let excludeModels = [];

        if (stats.isFile()) {
            const updates = yaml.safeLoad(fs.readFileSync("updates.yml", "utf8"));

            if (!updates.includeMfcModels) {
                updates.includeMfcModels = [];
            } else if (updates.includeMfcModels.length > 0) {
                this.msg(updates.includeMfcModels.length + " model(s) to include");
                includeModels = updates.includeMfcModels;
                updates.includeMfcModels = [];
            }

            if (!updates.excludeMfcModels) {
                updates.excludeMfcModels = [];
            } else if (updates.excludeMfcModels.length > 0) {
                this.msg(updates.excludeMfcModels.length + " model(s) to exclude");
                excludeModels = updates.excludeMfcModels;
                updates.excludeMfcModels = [];
            }

            // if there were some updates, then rewrite updates.yml
            if (includeModels.length > 0 || excludeModels.length > 0) {
                fs.writeFileSync("updates.yml", yaml.safeDump(updates), "utf8");
            }
        }

        return {includeModels: includeModels, excludeModels: excludeModels, dirty: false};
    }

    addModel(model) {
        if (super.addModel(model, this.config.mfcmodels)) {
            this.config.mfcmodels.push(model.uid);
            return true;
        }
        return false;
    }

    addModels(bundle) {
        // Fetch the UID of new models to add to capture list.
        // The model does not have to be online for this.
        const queries = [];

        for (let i = 0; i < bundle.includeModels.length; i++) {
            this.dbgMsg("Checking if " + colors.model(bundle.includeModels[i]) + " exists.");
            const query = this.queryUser(bundle.includeModels[i]).then((model) => {
                if (typeof model !== "undefined") {
                    bundle.dirty |= this.addModel(model);
                } else {
                    this.errMsg("Could not find model");
                }
            });
            queries.push(query);
        }

        return Promise.all(queries).then(function() {
            return bundle;
        });
    }

    removeModel(model) {
        this.config.mfcmodels = _.without(this.config.mfcmodels, model.uid);
        return super.removeModel(model);
    }

    removeModels(bundle) {
        // Fetch the UID of current models to be excluded from capture list.
        // The model does not have to be online for this.
        const queries = [];

        for (let i = 0; i < bundle.excludeModels.length; i++) {
            const query = this.queryUser(bundle.excludeModels[i]).then((model) => {
                if (typeof model !== "undefined") {
                    bundle.dirty |= this.removeModel(model);
                }
            });
            queries.push(query);
        }

        return Promise.all(queries).then(function() {
            return bundle.dirty;
        });
    }

    checkModelState(uid) {
        const me = this;

        return Promise.try(function() {
            return me.mfcGuest.queryUser(uid);
        }).then(function(model) {
            if (model !== undefined) {
                let isBroadcasting = 0;
                let msg = colors.model(model.nm);

                if (!me.modelList.has(model.nm)) {
                    me.modelList.set(model.nm, {uid: uid, nm: model.nm, modelState: "Offline", filename: ""});
                }

                const listitem = me.modelList.get(model.nm);

                if (model.vs === mfc.STATE.FreeChat) {
                    listitem.modelState = "Public Chat";
                    msg += " is in public chat!";
                    me.modelsToCap.push(model);
                    isBroadcasting = 1;
                } else if (model.vs === mfc.STATE.GroupShow) {
                    listitem.modelState = "Group Show";
                    msg += " is in a group show";
                } else if (model.vs === mfc.STATE.Private) {
                    if (model.truepvt === 1) {
                        listitem.modelState = "True Private";
                        msg += " is in a true private show.";
                    } else {
                        listitem.modelState = "Private";
                        msg += " is in a private show.";
                    }
                } else if (model.vs === mfc.STATE.Away) {
                    listitem.modelState = "Away";
                    msg += " is away.";
                } else if (model.vs === mfc.STATE.Online) {
                    listitem.modelState = "Away";
                    msg += colors.model("'s") + " cam is off.";
                } else if (model.vs === mfc.STATE.Offline) {
                    listitem.modelState = "Offline";
                    msg += " has logged off.";
                }
                me.modelList.set(model.nm, listitem);
                me.render();
                if ((me.modelState.has(uid) || model.vs !== mfc.STATE.Offline) && model.vs !== me.modelState.get(uid)) {
                    me.msg(msg);
                }
                me.modelState.set(uid, model.vs);
                if (me.currentlyCapping.has(model.uid) && isBroadcasting === 0) {
                    // Sometimes the ffmpeg process doesn't end when a model
                    // stops broadcasting, so terminate it.
                    me.dbgMsg(colors.model(model.nm) + " is no longer broadcasting, ending ffmpeg process.");
                    me.haltCapture(model.uid);
                }
            }
            return true;
        }).catch(function(err) {
            me.errMsg(err.toString());
            return err;
        });
    }

    getModelsToCap() {
        const queries = [];
        const me = this;

        me.modelsToCap = [];

        for (let i = 0; i < this.config.mfcmodels.length; i++) {
            queries.push(this.checkModelState(this.config.mfcmodels[i]));
        }

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
            const url = "http://video" + (model.u.camserv - 500) + ".myfreecams.com:1935/NxServer/ngrp:mfc_" + (100000000 + model.uid) + ".f4v_mobile/playlist.m3u8";
            const spawnArgs = me.getCaptureArguments(url, filename);

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

exports.Mfc = Mfc;

