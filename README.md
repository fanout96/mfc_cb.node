mfc_cb.node
==========

### Credit ###

This is a fork of [CapMyFreeCamsNodeJS](https://github.com/pusspounder/CapMyFreeCamsNodeJS) which is a fork of [mfc-node](https://github.com/sstativa/mfc-node), which is a fork of [capturbate-node](https://github.com/SN4T14/capturebate-node).

### About ###

mfc_cb.node will automatically record either MyFreeCams.com or Chaturbate.com streams.

This is a Node.JS application, so it works anywhere that Node.JS does.

mfc_cb.node reintegrates the Chaturbate support of the original capturbate-node, however capturbate-node uses an account login mechanism and rtmpdump to record.  mfc_cb.node does not login to your Chaturbate account and uses ffmpeg to record.

The primary feature enhancements over the parent repositories are:

* Automatic conversion from ts containers to either mp4 or mkv.  No need to run batch files.

* SIGINT handler so that it can be cleanly shut down and all post-process conversion steps completed for interrupted recordings.

* Ability to control output colors from config.yml (useful if you like dark themes, and blue is hard to read)

* Ability to control date/time/hour/minute/second format for the video file names and also to include the name of the site in the file name.

Setup
==========

* Dependencies: Install Node.JS, NPM, and ffmpeg

* Install mfc_cb.node
  >On GitHub, click `Clone or download`, `Download ZIP`.
  >Or run `git clone https://github.com/jrudess/mfc_cb.node.git`

* Run `npm install` to fetch all of the package dependences listed in package.json.

Instructions
===========

Refer to `config.yml`.

* MFC models are stored in `config.yml` using their MFC profile ID.  This allows mfc_cb.node to track the model across name changes.  To see or get this value manually, load the models profile page, right click and choose 'View Source', then search for nProfileID.

* Chaturbate models are only stored with their model name.

* Models can be added or removed by placing them into the appropriate section of `settings.yml`.  This file will get processed based on the `modelScanInterval` setting in `config.yml`.  When added to `settings.yml`, the model will be placed into the corresponding entry in `config.yml` and once the model has been seen online they will be added to the main record list. Because `config.yml` gets rewritten during this process, any manual edits you make to config.yml will be lost.  It is not recommended to manually add models to config.yml while the program is running, but instead to add them to `settings.yml`.

* To run: `node main.js`

