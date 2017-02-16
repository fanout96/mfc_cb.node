mfc_cb.node
==========

### Credit ###

This is a fork of [CapMyFreeCamsNodeJS](https://github.com/pusspounder/CapMyFreeCamsNodeJS) which is a fork of [mfc-node](https://github.com/sstativa/mfc-node), which is a fork of [capturbate-node](https://github.com/SN4T14/capturebate-node).

### About ###

mfc_cb.node will automatically record either MyFreeCams.com or Chaturbate.com streams.

This is a Node.JS application, so it works anywhere that Node.JS does.

* Uses ffmpeg for all captures.

* Automatic (optional) post-process conversion from ts containers to mp4 or mkv.

* SIGINT handler which cleanly shuts down, stopping all captures, and finishing all post-process conversions.

* Captures are named in the format model_site_datetime.[mp4|mkv]

  * datetime format can be controlled in the config file

  * site is optional and can be disabled in the config file

Setup
==========

* Dependencies: `node.js >= 7.0`, `npm`, `git`, and `ffmpeg`

  * `git` is only needed to run 'npm install' and not to run mfc_cb.node

* Install mfc_cb.node
  >On GitHub, click `Clone or download`, `Download ZIP`.
  >Or run `git clone https://github.com/jrudess/mfc_cb.node.git`

* Run `npm install` to fetch all of the package dependences listed in package.json.

Instructions
===========

Refer to `config.yml`.

* Models can be added or removed by placing them into the appropriate section of `updates.yml`.  This file will get processed based on the `modelScanInterval` setting in `config.yml`.  Any listed models will be added or removed from `config.yml`. Because `config.yml` gets rewritten during this process, any manual edits made to this file will be lost.  It is not recommended to manually add models to `config.yml` while the program is running, but instead to add them to `updates.yml`.

* MFC models are stored in `config.yml` using their MFC profile ID.  This allows mfc_cb.node to track the model across name changes.  To find the profile ID manually, load the models profile page, right click and choose 'View Source', then search for nProfileUserID.  However, when adding MFC models to `updates.yml` the model's name is used so that looking up the profile ID is not necessary.

* Chaturbate models are only stored with their model name and can not currently track a model name change.

* NOTE: Model names are case sensitive.  If captures are not starting, double check whether the model name has the correct case for all characters.

* To run: `node main.js`
* To run without color: `node main.js --no-color`

