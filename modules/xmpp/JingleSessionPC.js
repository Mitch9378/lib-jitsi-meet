/* jshint -W117 */

var logger = require("jitsi-meet-logger").getLogger(__filename);
var JingleSession = require("./JingleSession");
var TraceablePeerConnection = require("./TraceablePeerConnection");
var SDPDiffer = require("./SDPDiffer");
var SDPUtil = require("./SDPUtil");
var SDP = require("./SDP");
var async = require("async");
var XMPPEvents = require("../../service/xmpp/XMPPEvents");
var RTCBrowserType = require("../RTC/RTCBrowserType");
var RTC = require("../RTC/RTC");

/**
 * Constant tells how long we're going to wait for IQ response, before timeout
 * error is  triggered.
 * @type {number}
 */
var IQ_TIMEOUT = 10000;

// Jingle stuff
function JingleSessionPC(me, sid, peerjid, connection,
                         media_constraints, ice_config, service, eventEmitter) {
    JingleSession.call(this, me, sid, peerjid, connection,
                       media_constraints, ice_config, service, eventEmitter);
    this.localSDP = null;
    this.remoteSDP = null;

    this.hadstuncandidate = false;
    this.hadturncandidate = false;
    this.lasticecandidate = false;

    this.addssrc = [];
    this.removessrc = [];
    this.pendingop = null;
    this.modifyingLocalStreams = false;
    this.modifiedSSRCs = {};

    /**
     * A map that stores SSRCs of remote streams. And is used only locally
     * We store the mapping when jingle is received, and later is used
     * onaddstream webrtc event where we have only the ssrc
     * FIXME: This map got filled and never cleaned and can grow durring long
     * conference
     * @type {{}} maps SSRC number to jid
     */
    this.ssrcOwners = {};

    this.webrtcIceUdpDisable = !!this.service.options.webrtcIceUdpDisable;
    this.webrtcIceTcpDisable = !!this.service.options.webrtcIceTcpDisable;

    this.modifySourcesQueue = async.queue(this._modifySources.bind(this), 1);
    // We start with the queue paused. We resume it when the signaling state is
    // stable and the ice connection state is connected.
    this.modifySourcesQueue.pause();
}
//XXX this is badly broken...
JingleSessionPC.prototype = JingleSession.prototype;
JingleSessionPC.prototype.constructor = JingleSessionPC;


JingleSessionPC.prototype.updateModifySourcesQueue = function() {
    var signalingState = this.peerconnection.signalingState;
    var iceConnectionState = this.peerconnection.iceConnectionState;
    if (signalingState === 'stable' && iceConnectionState === 'connected') {
        this.modifySourcesQueue.resume();
    } else {
        this.modifySourcesQueue.pause();
    }
};

JingleSessionPC.prototype.doInitialize = function () {
    var self = this;

    this.hadstuncandidate = false;
    this.hadturncandidate = false;
    this.lasticecandidate = false;
    // True if reconnect is in progress
    this.isreconnect = false;
    // Set to true if the connection was ever stable
    this.wasstable = false;

    this.peerconnection = new TraceablePeerConnection(
            this.connection.jingle.ice_config,
            RTC.getPCConstraints(),
            this);

    this.peerconnection.onicecandidate = function (ev) {
        if (!ev) {
            // There was an incomplete check for ev before which left the last
            // line of the function unprotected from a potential throw of an
            // exception. Consequently, it may be argued that the check is
            // unnecessary. Anyway, I'm leaving it and making the check
            // complete.
            return;
        }
        var candidate = ev.candidate;
        if (candidate) {
            // Discard candidates of disabled protocols.
            var protocol = candidate.protocol;
            if (typeof protocol === 'string') {
                protocol = protocol.toLowerCase();
                if (protocol == 'tcp') {
                    if (self.webrtcIceTcpDisable)
                        return;
                } else if (protocol == 'udp') {
                    if (self.webrtcIceUdpDisable)
                        return;
                }
            }
        }
        self.sendIceCandidate(candidate);
    };
    this.peerconnection.onaddstream = function (event) {
        if (event.stream.id !== 'default') {
            logger.log("REMOTE STREAM ADDED: ", event.stream , event.stream.id);
            self.remoteStreamAdded(event);
        } else {
            // This is a recvonly stream. Clients that implement Unified Plan,
            // such as Firefox use recvonly "streams/channels/tracks" for
            // receiving remote stream/tracks, as opposed to Plan B where there
            // are only 3 channels: audio, video and data.
            logger.log("RECVONLY REMOTE STREAM IGNORED: " + event.stream + " - " + event.stream.id);
        }
    };
    this.peerconnection.onremovestream = function (event) {
        // Remove the stream from remoteStreams
        if (event.stream.id !== 'default') {
            logger.log("REMOTE STREAM REMOVED: ", event.stream , event.stream.id);
            self.remoteStreamRemoved(event);
        } else {
            // This is a recvonly stream. Clients that implement Unified Plan,
            // such as Firefox use recvonly "streams/channels/tracks" for
            // receiving remote stream/tracks, as opposed to Plan B where there
            // are only 3 channels: audio, video and data.
            logger.log("RECVONLY REMOTE STREAM IGNORED: " + event.stream + " - " + event.stream.id);
        }
    };
    this.peerconnection.onsignalingstatechange = function (event) {
        if (!(self && self.peerconnection)) return;
        if (self.peerconnection.signalingState === 'stable') {
            self.wasstable = true;
        }
        self.updateModifySourcesQueue();
    };
    /**
     * The oniceconnectionstatechange event handler contains the code to execute when the iceconnectionstatechange event,
     * of type Event, is received by this RTCPeerConnection. Such an event is sent when the value of
     * RTCPeerConnection.iceConnectionState changes.
     *
     * @param event the event containing information about the change
     */
    this.peerconnection.oniceconnectionstatechange = function (event) {
        if (!(self && self.peerconnection)) return;
        logger.log("(TIME) ICE " + self.peerconnection.iceConnectionState +
                    ":\t", window.performance.now());
        self.updateModifySourcesQueue();
        switch (self.peerconnection.iceConnectionState) {
            case 'connected':

                // Informs interested parties that the connection has been restored.
                if (self.peerconnection.signalingState === 'stable' && self.isreconnect)
                    self.room.eventEmitter.emit(XMPPEvents.CONNECTION_RESTORED);
                self.isreconnect = false;

                break;
            case 'disconnected':
                self.isreconnect = true;
                // Informs interested parties that the connection has been interrupted.
                if (self.wasstable)
                    self.room.eventEmitter.emit(XMPPEvents.CONNECTION_INTERRUPTED);
                break;
            case 'failed':
                self.room.eventEmitter.emit(XMPPEvents.CONFERENCE_SETUP_FAILED);
                break;
        }
    };
    this.peerconnection.onnegotiationneeded = function (event) {
        self.room.eventEmitter.emit(XMPPEvents.PEERCONNECTION_READY, self);
    };
};

JingleSessionPC.prototype.sendIceCandidate = function (candidate) {
    var self = this;
    if (candidate && !this.lasticecandidate) {
        var ice = SDPUtil.iceparams(this.localSDP.media[candidate.sdpMLineIndex], this.localSDP.session);
        var jcand = SDPUtil.candidateToJingle(candidate.candidate);
        if (!(ice && jcand)) {
            logger.error('failed to get ice && jcand');
            return;
        }
        ice.xmlns = 'urn:xmpp:jingle:transports:ice-udp:1';

        if (jcand.type === 'srflx') {
            this.hadstuncandidate = true;
        } else if (jcand.type === 'relay') {
            this.hadturncandidate = true;
        }

        if (this.usedrip) {
            if (this.drip_container.length === 0) {
                // start 20ms callout
                window.setTimeout(function () {
                    if (self.drip_container.length === 0) return;
                    self.sendIceCandidates(self.drip_container);
                    self.drip_container = [];
                }, 20);
            }
            this.drip_container.push(candidate);
        } else {
            self.sendIceCandidates([candidate]);
        }
    } else {
        logger.log('sendIceCandidate: last candidate.');
        // FIXME: remember to re-think in ICE-restart
        this.lasticecandidate = true;
        logger.log('Have we encountered any srflx candidates? ' + this.hadstuncandidate);
        logger.log('Have we encountered any relay candidates? ' + this.hadturncandidate);
    }
};

JingleSessionPC.prototype.sendIceCandidates = function (candidates) {
    logger.log('sendIceCandidates', candidates);
    var cand = $iq({to: this.peerjid, type: 'set'})
        .c('jingle', {xmlns: 'urn:xmpp:jingle:1',
            action: 'transport-info',
            initiator: this.initiator,
            sid: this.sid});
    for (var mid = 0; mid < this.localSDP.media.length; mid++) {
        var cands = candidates.filter(function (el) { return el.sdpMLineIndex == mid; });
        var mline = SDPUtil.parse_mline(this.localSDP.media[mid].split('\r\n')[0]);
        if (cands.length > 0) {
            var ice = SDPUtil.iceparams(this.localSDP.media[mid], this.localSDP.session);
            ice.xmlns = 'urn:xmpp:jingle:transports:ice-udp:1';
            cand.c('content', {creator: this.initiator == this.me ? 'initiator' : 'responder',
                name: (cands[0].sdpMid? cands[0].sdpMid : mline.media)
            }).c('transport', ice);
            for (var i = 0; i < cands.length; i++) {
                cand.c('candidate', SDPUtil.candidateToJingle(cands[i].candidate)).up();
            }
            // add fingerprint
            var fingerprint_line = SDPUtil.find_line(this.localSDP.media[mid], 'a=fingerprint:', this.localSDP.session);
            if (fingerprint_line) {
                var tmp = SDPUtil.parse_fingerprint(fingerprint_line);
                tmp.required = true;
                cand.c(
                    'fingerprint',
                    {xmlns: 'urn:xmpp:jingle:apps:dtls:0'})
                    .t(tmp.fingerprint);
                delete tmp.fingerprint;
                cand.attrs(tmp);
                cand.up();
            }
            cand.up(); // transport
            cand.up(); // content
        }
    }
    // might merge last-candidate notification into this, but it is called alot later. See webrtc issue #2340
    //logger.log('was this the last candidate', this.lasticecandidate);
    this.connection.sendIQ(
        cand, null, this.newJingleErrorHandler(cand), IQ_TIMEOUT);
};

JingleSessionPC.prototype.readSsrcInfo = function (contents) {
    var self = this;
    $(contents).each(function (idx, content) {
        var name = $(content).attr('name');
        var mediaType = this.getAttribute('name');
        var ssrcs = $(content).find('description>source[xmlns="urn:xmpp:jingle:apps:rtp:ssma:0"]');
        ssrcs.each(function () {
            var ssrc = this.getAttribute('ssrc');
            $(this).find('>ssrc-info[xmlns="http://jitsi.org/jitmeet"]').each(
                function () {
                    var owner = this.getAttribute('owner');
                    self.ssrcOwners[ssrc] = owner;
                }
            );
        });
    });
};

JingleSessionPC.prototype.acceptOffer = function(jingleOffer,
                                                 success, failure) {
    this.state = 'active';
    this.setRemoteDescription(jingleOffer, 'offer',
        function() {
            this.sendAnswer(success, failure);
        }.bind(this),
        failure);
};

JingleSessionPC.prototype.setRemoteDescription = function (elem, desctype,
                                                           success, failure) {
    //logger.log('setting remote description... ', desctype);
    this.remoteSDP = new SDP('');
    if (this.webrtcIceTcpDisable) {
        this.remoteSDP.removeTcpCandidates = true;
    }
    if (this.webrtcIceUdpDisable) {
        this.remoteSDP.removeUdpCandidates = true;
    }

    this.remoteSDP.fromJingle(elem);
    this.readSsrcInfo($(elem).find(">content"));
    var remotedesc = new RTCSessionDescription({type: desctype, sdp: this.remoteSDP.raw});

    this.peerconnection.setRemoteDescription(remotedesc,
        function () {
            //logger.log('setRemoteDescription success');
            if (success) {
                success();
            }
        },
        function (e) {
            logger.error('setRemoteDescription error', e);
            if (failure)
                failure(e);
            JingleSessionPC.onJingleFatalError(this, e);
        }.bind(this)
    );
};

JingleSessionPC.prototype.sendAnswer = function (success, failure) {
    //logger.log('createAnswer');
    this.peerconnection.createAnswer(
        function (sdp) {
            this.createdAnswer(sdp, success, failure);
        }.bind(this),
        function (error) {
            logger.error("createAnswer failed", error);
            if (failure)
                failure(error);
            this.room.eventEmitter.emit(
                    XMPPEvents.CONFERENCE_SETUP_FAILED, error);
        }.bind(this),
        this.media_constraints
    );
};

JingleSessionPC.prototype.createdAnswer = function (sdp, success, failure) {
    //logger.log('createAnswer callback');
    var self = this;
    this.localSDP = new SDP(sdp.sdp);
    var sendJingle = function (ssrcs) {
                var accept = $iq({to: self.peerjid,
                    type: 'set'})
                    .c('jingle', {xmlns: 'urn:xmpp:jingle:1',
                        action: 'session-accept',
                        initiator: self.initiator,
                        responder: self.responder,
                        sid: self.sid });
                if (self.webrtcIceTcpDisable) {
                    self.localSDP.removeTcpCandidates = true;
                }
                if (self.webrtcIceUdpDisable) {
                    self.localSDP.removeUdpCandidates = true;
                }
                self.localSDP.toJingle(
                    accept,
                    self.initiator == self.me ? 'initiator' : 'responder',
                    ssrcs);
                self.fixJingle(accept);
                self.connection.sendIQ(accept,
                    success,
                    self.newJingleErrorHandler(accept, failure),
                    IQ_TIMEOUT);
    };
    sdp.sdp = this.localSDP.raw;
    this.peerconnection.setLocalDescription(sdp,
        function () {
            //logger.log('setLocalDescription success');
            sendJingle(success, failure);
        },
        function (error) {
            logger.error('setLocalDescription failed', error);
            if (failure)
                failure(error);
            self.room.eventEmitter.emit(XMPPEvents.CONFERENCE_SETUP_FAILED);
        }
    );
    var cands = SDPUtil.find_lines(this.localSDP.raw, 'a=candidate:');
    for (var j = 0; j < cands.length; j++) {
        var cand = SDPUtil.parse_icecandidate(cands[j]);
        if (cand.type == 'srflx') {
            this.hadstuncandidate = true;
        } else if (cand.type == 'relay') {
            this.hadturncandidate = true;
        }
    }
};

JingleSessionPC.prototype.terminate = function (reason,  text,
                                                success, failure) {
    var term = $iq({to: this.peerjid,
        type: 'set'})
        .c('jingle', {xmlns: 'urn:xmpp:jingle:1',
            action: 'session-terminate',
            initiator: this.initiator,
            sid: this.sid})
        .c('reason')
        .c(reason || 'success');

    if (text) {
        term.up().c('text').t(text);
    }

    this.connection.sendIQ(
        term, success, this.newJingleErrorHandler(term, failure), IQ_TIMEOUT);

    // this should result in 'onTerminated' being called by strope.jingle.js
    this.connection.jingle.terminate(this.sid);
};

JingleSessionPC.prototype.onTerminated = function (reasonCondition,
                                                   reasonText) {
    this.state = 'ended';

    // Do something with reason and reasonCondition when we start to care
    //this.reasonCondition = reasonCondition;
    //this.reasonText = reasonText;
    logger.info("Session terminated", this, reasonCondition, reasonText);

    if (this.peerconnection)
        this.peerconnection.close();
};

/**
 * Handles a Jingle source-add message for this Jingle session.
 * @param elem An array of Jingle "content" elements.
 */
JingleSessionPC.prototype.addSource = function (elem) {

    var self = this;
    // FIXME: dirty waiting
    if (!this.peerconnection.localDescription)
    {
        logger.warn("addSource - localDescription not ready yet")
        setTimeout(function()
            {
                self.addSource(elem);
            },
            200
        );
        return;
    }

    logger.log('addssrc', new Date().getTime());
    logger.log('ice', this.peerconnection.iceConnectionState);

    this.readSsrcInfo(elem);

    var sdp = new SDP(this.peerconnection.remoteDescription.sdp);
    var mySdp = new SDP(this.peerconnection.localDescription.sdp);

    $(elem).each(function (idx, content) {
        var name = $(content).attr('name');
        var lines = '';
        $(content).find('ssrc-group[xmlns="urn:xmpp:jingle:apps:rtp:ssma:0"]').each(function() {
            var semantics = this.getAttribute('semantics');
            var ssrcs = $(this).find('>source').map(function () {
                return this.getAttribute('ssrc');
            }).get();

            if (ssrcs.length) {
                lines += 'a=ssrc-group:' + semantics + ' ' + ssrcs.join(' ') + '\r\n';
            }
        });
        var tmp = $(content).find('source[xmlns="urn:xmpp:jingle:apps:rtp:ssma:0"]'); // can handle both >source and >description>source
        tmp.each(function () {
            var ssrc = $(this).attr('ssrc');
            if(mySdp.containsSSRC(ssrc)){
                /**
                 * This happens when multiple participants change their streams at the same time and
                 * ColibriFocus.modifySources have to wait for stable state. In the meantime multiple
                 * addssrc are scheduled for update IQ. See
                 */
                logger.warn("Got add stream request for my own ssrc: "+ssrc);
                return;
            }
            if (sdp.containsSSRC(ssrc)) {
                logger.warn("Source-add request for existing SSRC: " + ssrc);
                return;
            }
            $(this).find('>parameter').each(function () {
                lines += 'a=ssrc:' + ssrc + ' ' + $(this).attr('name');
                if ($(this).attr('value') && $(this).attr('value').length)
                    lines += ':' + $(this).attr('value');
                lines += '\r\n';
            });
        });
        sdp.media.forEach(function(media, idx) {
            if (!SDPUtil.find_line(media, 'a=mid:' + name))
                return;
            sdp.media[idx] += lines;
            if (!self.addssrc[idx]) self.addssrc[idx] = '';
            self.addssrc[idx] += lines;
        });
        sdp.raw = sdp.session + sdp.media.join('');
    });

    this.modifySourcesQueue.push(function() {
        // When a source is added and if this is FF, a new channel is allocated
        // for receiving the added source. We need to diffuse the SSRC of this
        // new recvonly channel to the rest of the peers.
        logger.log('modify sources done');

        var newSdp = new SDP(self.peerconnection.localDescription.sdp);
        logger.log("SDPs", mySdp, newSdp);
        self.notifyMySSRCUpdate(mySdp, newSdp);
    });
};

/**
 * Handles a Jingle source-remove message for this Jingle session.
 * @param elem An array of Jingle "content" elements.
 */
JingleSessionPC.prototype.removeSource = function (elem) {

    var self = this;
    // FIXME: dirty waiting
    if (!this.peerconnection.localDescription) {
        logger.warn("removeSource - localDescription not ready yet");
        setTimeout(function() {
                self.removeSource(elem);
            },
            200
        );
        return;
    }

    logger.log('removessrc', new Date().getTime());
    logger.log('ice', this.peerconnection.iceConnectionState);
    var sdp = new SDP(this.peerconnection.remoteDescription.sdp);
    var mySdp = new SDP(this.peerconnection.localDescription.sdp);

    $(elem).each(function (idx, content) {
        var name = $(content).attr('name');
        var lines = '';
        $(content).find('ssrc-group[xmlns="urn:xmpp:jingle:apps:rtp:ssma:0"]').each(function() {
            var semantics = this.getAttribute('semantics');
            var ssrcs = $(this).find('>source').map(function () {
                return this.getAttribute('ssrc');
            }).get();

            if (ssrcs.length) {
                lines += 'a=ssrc-group:' + semantics + ' ' + ssrcs.join(' ') + '\r\n';
            }
        });
        var tmp = $(content).find('source[xmlns="urn:xmpp:jingle:apps:rtp:ssma:0"]'); // can handle both >source and >description>source
        tmp.each(function () {
            var ssrc = $(this).attr('ssrc');
            // This should never happen, but can be useful for bug detection
            if(mySdp.containsSSRC(ssrc)){
                logger.error("Got remove stream request for my own ssrc: "+ssrc);
                return;
            }
            $(this).find('>parameter').each(function () {
                lines += 'a=ssrc:' + ssrc + ' ' + $(this).attr('name');
                if ($(this).attr('value') && $(this).attr('value').length)
                    lines += ':' + $(this).attr('value');
                lines += '\r\n';
            });
        });
        sdp.media.forEach(function(media, idx) {
            if (!SDPUtil.find_line(media, 'a=mid:' + name))
                return;
            sdp.media[idx] += lines;
            if (!self.removessrc[idx]) self.removessrc[idx] = '';
            self.removessrc[idx] += lines;
        });
        sdp.raw = sdp.session + sdp.media.join('');
    });

    this.modifySourcesQueue.push(function() {
        // When a source is removed and if this is FF, the recvonly channel that
        // receives the remote stream is deactivated . We need to diffuse the
        // recvonly SSRC removal to the rest of the peers.
        logger.log('modify sources done');

        var newSdp = new SDP(self.peerconnection.localDescription.sdp);
        logger.log("SDPs", mySdp, newSdp);
        self.notifyMySSRCUpdate(mySdp, newSdp);
    });
};

JingleSessionPC.prototype._modifySources = function (successCallback, queueCallback) {
    var self = this;

    if (this.peerconnection.signalingState == 'closed') return;
    if (!(this.addssrc.length || this.removessrc.length || this.pendingop !== null
        || this.modifyingLocalStreams)){
        // There is nothing to do since scheduled job might have been
        // executed by another succeeding call
        if(successCallback){
            successCallback();
        }
        queueCallback();
        return;
    }

    // Reset switch streams flags
    this.modifyingLocalStreams = false;

    var sdp = new SDP(this.peerconnection.remoteDescription.sdp);

    // add sources
    this.addssrc.forEach(function(lines, idx) {
        sdp.media[idx] += lines;
    });
    this.addssrc = [];

    // remove sources
    this.removessrc.forEach(function(lines, idx) {
        lines = lines.split('\r\n');
        lines.pop(); // remove empty last element;
        lines.forEach(function(line) {
            sdp.media[idx] = sdp.media[idx].replace(line + '\r\n', '');
        });
    });
    this.removessrc = [];

    sdp.raw = sdp.session + sdp.media.join('');
    this.peerconnection.setRemoteDescription(new RTCSessionDescription({type: 'offer', sdp: sdp.raw}),
        function() {

            if(self.signalingState == 'closed') {
                logger.error("createAnswer attempt on closed state");
                queueCallback("createAnswer attempt on closed state");
                return;
            }

            self.peerconnection.createAnswer(
                function(modifiedAnswer) {
                    // change video direction, see https://github.com/jitsi/jitmeet/issues/41
                    if (self.pendingop !== null) {
                        var sdp = new SDP(modifiedAnswer.sdp);
                        if (sdp.media.length > 1) {
                            switch(self.pendingop) {
                                case 'mute':
                                    sdp.media[1] = sdp.media[1].replace('a=sendrecv', 'a=recvonly');
                                    break;
                                case 'unmute':
                                    sdp.media[1] = sdp.media[1].replace('a=recvonly', 'a=sendrecv');
                                    break;
                            }
                            sdp.raw = sdp.session + sdp.media.join('');
                            modifiedAnswer.sdp = sdp.raw;
                        }
                        self.pendingop = null;
                    }

                    // FIXME: pushing down an answer while ice connection state
                    // is still checking is bad...
                    //logger.log(self.peerconnection.iceConnectionState);

                    // trying to work around another chrome bug
                    //modifiedAnswer.sdp = modifiedAnswer.sdp.replace(/a=setup:active/g, 'a=setup:actpass');
                    self.peerconnection.setLocalDescription(modifiedAnswer,
                        function() {
                            if(successCallback){
                                successCallback();
                            }
                            queueCallback();
                        },
                        function(error) {
                            logger.error('modified setLocalDescription failed', error);
                            queueCallback(error);
                        }
                    );
                },
                function(error) {
                    logger.error('modified answer failed', error);
                    queueCallback(error);
                }
            );
        },
        function(error) {
            logger.error('modify failed', error);
            queueCallback(error);
        }
    );
};

/**
 * Adds stream.
 * @param stream new stream that will be added.
 * @param success_callback callback executed after successful stream addition.
 * @param ssrcInfo object with information about the SSRCs associated with the
 * stream.
 * @param dontModifySources {boolean} if true _modifySources won't be called.
 * Used for streams added before the call start.
 */
JingleSessionPC.prototype.addStream = function (stream, callback, ssrcInfo,
    dontModifySources) {
    // Remember SDP to figure out added/removed SSRCs
    var oldSdp = null;
    if(this.peerconnection) {
        if(this.peerconnection.localDescription) {
            oldSdp = new SDP(this.peerconnection.localDescription.sdp);
        }
        //when adding muted stream we have to pass the ssrcInfo but we don't
        //have a stream
        if(stream || ssrcInfo)
            this.peerconnection.addStream(stream, ssrcInfo);
    }

    // Conference is not active
    if(!oldSdp || !this.peerconnection || dontModifySources) {
        if(ssrcInfo) {
            //available only on video unmute or when adding muted stream
            this.modifiedSSRCs[ssrcInfo.type] =
                this.modifiedSSRCs[ssrcInfo.type] || [];
            this.modifiedSSRCs[ssrcInfo.type].push(ssrcInfo);
        }
        callback();
        return;
    }

    this.modifyingLocalStreams = true;
    var self = this;
    this.modifySourcesQueue.push(function() {
        logger.log('modify sources done');
        if(ssrcInfo) {
            //available only on video unmute or when adding muted stream
            self.modifiedSSRCs[ssrcInfo.type] =
                self.modifiedSSRCs[ssrcInfo.type] || [];
            self.modifiedSSRCs[ssrcInfo.type].push(ssrcInfo);
        }
        callback();
        var newSdp = new SDP(self.peerconnection.localDescription.sdp);
        logger.log("SDPs", oldSdp, newSdp);
        self.notifyMySSRCUpdate(oldSdp, newSdp);
    });
}

/**
 * Generate ssrc info object for a stream with the following properties:
 * - ssrcs - Array of the ssrcs associated with the stream.
 * - groups - Array of the groups associated with the stream.
 */
JingleSessionPC.prototype.generateNewStreamSSRCInfo = function () {
    return this.peerconnection.generateNewStreamSSRCInfo();
};

/**
 * Remove streams.
 * @param stream stream that will be removed.
 * @param success_callback callback executed after successful stream addition.
 * @param ssrcInfo object with information about the SSRCs associated with the
 * stream.
 */
JingleSessionPC.prototype.removeStream = function (stream, callback, ssrcInfo) {
    // Remember SDP to figure out added/removed SSRCs
    var oldSdp = null;
    if(this.peerconnection) {
        if(this.peerconnection.localDescription) {
            oldSdp = new SDP(this.peerconnection.localDescription.sdp);
        }
        if (RTCBrowserType.getBrowserType() ===
                RTCBrowserType.RTC_BROWSER_FIREFOX) {
            if(!stream)//There is nothing to be changed
                return;
            var sender = null;
            // On Firefox we don't replace MediaStreams as this messes up the
            // m-lines (which can't be removed in Plan Unified) and brings a lot
            // of complications. Instead, we use the RTPSender and remove just
            // the track.
            var track = null;
            if(stream.getAudioTracks() && stream.getAudioTracks().length) {
                track = stream.getAudioTracks()[0];
            } else if(stream.getVideoTracks() && stream.getVideoTracks().length)
            {
                track = stream.getVideoTracks()[0];
            }

            if(!track) {
                logger.log("Cannot remove tracks: no tracks.");
                return;
            }

            // Find the right sender (for audio or video)
            this.peerconnection.peerconnection.getSenders().some(function (s) {
                if (s.track === track) {
                    sender = s;
                    return true;
                }
            });

            if (sender) {
                this.peerconnection.peerconnection.removeTrack(sender);
            } else {
                logger.log("Cannot remove tracks: no RTPSender.");
            }
        } else if(stream)
            this.peerconnection.removeStream(stream, false, ssrcInfo);
        // else
        // NOTE: If there is no stream and the browser is not FF we still need to do
        // some transformation in order to send remove-source for the muted
        // streams. That's why we aren't calling return here.
    }

    // Conference is not active
    if(!oldSdp || !this.peerconnection) {
        callback();
        return;
    }

    this.modifyingLocalStreams = true;
    var self = this;
    this.modifySourcesQueue.push(function() {
        logger.log('modify sources done');

        callback();

        var newSdp = new SDP(self.peerconnection.localDescription.sdp);
        if(ssrcInfo) {
            self.modifiedSSRCs[ssrcInfo.type] =
                self.modifiedSSRCs[ssrcInfo.type] || [];
            self.modifiedSSRCs[ssrcInfo.type].push(ssrcInfo);
        }
        logger.log("SDPs", oldSdp, newSdp);
        self.notifyMySSRCUpdate(oldSdp, newSdp);
    });
}

/**
 * Figures out added/removed ssrcs and send update IQs.
 * @param old_sdp SDP object for old description.
 * @param new_sdp SDP object for new description.
 */
JingleSessionPC.prototype.notifyMySSRCUpdate = function (old_sdp, new_sdp) {

    if (!(this.peerconnection.signalingState == 'stable' &&
        this.peerconnection.iceConnectionState == 'connected')){
        logger.log("Too early to send updates");
        return;
    }

    // send source-remove IQ.
    sdpDiffer = new SDPDiffer(new_sdp, old_sdp);
    var remove = $iq({to: this.peerjid, type: 'set'})
        .c('jingle', {
            xmlns: 'urn:xmpp:jingle:1',
            action: 'source-remove',
            initiator: this.initiator,
            sid: this.sid
        }
    );
    sdpDiffer.toJingle(remove);
    var removed = this.fixJingle(remove);

    if (removed && remove) {
        logger.info("Sending source-remove", remove.tree());
        this.connection.sendIQ(
            remove, null, this.newJingleErrorHandler(remove), IQ_TIMEOUT);
    } else {
        logger.log('removal not necessary');
    }

    // send source-add IQ.
    var sdpDiffer = new SDPDiffer(old_sdp, new_sdp);
    var add = $iq({to: this.peerjid, type: 'set'})
        .c('jingle', {
            xmlns: 'urn:xmpp:jingle:1',
            action: 'source-add',
            initiator: this.initiator,
            sid: this.sid
        }
    );

    sdpDiffer.toJingle(add);
    var added = this.fixJingle(add);

    if (added && add) {
        logger.info("Sending source-add", add.tree());
        this.connection.sendIQ(
            add, null, this.newJingleErrorHandler(add), IQ_TIMEOUT);
    } else {
        logger.log('addition not necessary');
    }
};

JingleSessionPC.prototype.newJingleErrorHandler = function(request, failureCb) {
    return function (errResponse) {

        var error = { };

        // Get XMPP error code and condition(reason)
        var errorElSel = $(errResponse).find('error');
        if (errorElSel.length) {
            error.code = errorElSel.attr('code');
            var errorReasonSel = $(errResponse).find('error :first');
            if (errorReasonSel.length)
                error.reason = errorReasonSel[0].tagName;
        }

        error.source = request ? request.tree() : null;
        error.session = this;

        logger.error("Jingle error", error);
        if (failureCb) {
            failureCb(error);
        }

        this.room.eventEmitter.emit(XMPPEvents.JINGLE_ERROR, error);

    }.bind(this);
};

JingleSessionPC.onJingleFatalError = function (session, error)
{
    this.room.eventEmitter.emit(XMPPEvents.CONFERENCE_SETUP_FAILED);
    this.room.eventEmitter.emit(XMPPEvents.JINGLE_FATAL_ERROR, session, error);
};

JingleSessionPC.prototype.remoteStreamAdded = function (data, times) {
    var self = this;
    var thessrc;
    var streamId = RTC.getStreamID(data.stream);

    // look up an associated JID for a stream id
    if (!streamId) {
        logger.error("No stream ID for", data.stream);
    } else if (streamId && streamId.indexOf('mixedmslabel') === -1) {
        // look only at a=ssrc: and _not_ at a=ssrc-group: lines

        var ssrclines = this.peerconnection.remoteDescription?
            SDPUtil.find_lines(this.peerconnection.remoteDescription.sdp, 'a=ssrc:') : [];
        ssrclines = ssrclines.filter(function (line) {
            // NOTE(gp) previously we filtered on the mslabel, but that property
            // is not always present.
            // return line.indexOf('mslabel:' + data.stream.label) !== -1;

            if (RTCBrowserType.isTemasysPluginUsed()) {
                return ((line.indexOf('mslabel:' + streamId) !== -1));
            } else {
                return ((line.indexOf('msid:' + streamId) !== -1));
            }
        });
        if (ssrclines.length) {
            thessrc = ssrclines[0].substring(7).split(' ')[0];

            if (!self.ssrcOwners[thessrc]) {
                logger.error("No SSRC owner known for: " + thessrc);
                return;
            }
            data.peerjid = self.ssrcOwners[thessrc];
            logger.log('associated jid', self.ssrcOwners[thessrc]);
        } else {
            logger.error("No SSRC lines for ", streamId);
        }
    }

    this.room.remoteStreamAdded(data, this.sid, thessrc);
};

/**
 * Handles remote stream removal.
 * @param event The event object associated with the removal.
 */
JingleSessionPC.prototype.remoteStreamRemoved = function (event) {
    var thessrc;
    var streamId = RTC.getStreamID(event.stream);
    if (!streamId) {
        logger.error("No stream ID for", event.stream);
    } else if (streamId && streamId.indexOf('mixedmslabel') === -1) {
        this.room.eventEmitter.emit(XMPPEvents.REMOTE_STREAM_REMOVED, streamId);
    }
};

/**
 * Returns the ice connection state for the peer connection.
 * @returns the ice connection state for the peer connection.
 */
JingleSessionPC.prototype.getIceConnectionState = function () {
    return this.peerconnection.iceConnectionState;
};


/**
 * Fixes the outgoing jingle packets by removing the nodes related to the
 * muted/unmuted streams, handles removing of muted stream, etc.
 * @param jingle the jingle packet that is going to be sent
 * @returns {boolean} true if the jingle has to be sent and false otherwise.
 */
JingleSessionPC.prototype.fixJingle = function(jingle) {
    var action = $(jingle.nodeTree).find("jingle").attr("action");
    switch (action) {
        case "source-add":
        case "session-accept":
            this.fixSourceAddJingle(jingle);
            break;
        case "source-remove":
            this.fixSourceRemoveJingle(jingle);
            break;
        default:
            logger.error("Unknown jingle action!");
            return false;
    }

    var sources = $(jingle.tree()).find(">jingle>content>description>source");
    return sources && sources.length > 0;
};

/**
 * Fixes the outgoing jingle packets with action source-add by removing the
 * nodes related to the unmuted streams
 * @param jingle the jingle packet that is going to be sent
 * @returns {boolean} true if the jingle has to be sent and false otherwise.
 */
JingleSessionPC.prototype.fixSourceAddJingle = function (jingle) {
    var ssrcs = this.modifiedSSRCs["unmute"];
    this.modifiedSSRCs["unmute"] = [];
    if(ssrcs && ssrcs.length) {
        ssrcs.forEach(function (ssrcObj) {
            var desc = $(jingle.tree()).find(">jingle>content[name=\"" +
                ssrcObj.mtype + "\"]>description");
            if(!desc || !desc.length)
                return;
            ssrcObj.ssrc.ssrcs.forEach(function (ssrc) {
                var sourceNode = desc.find(">source[ssrc=\"" +
                    ssrc + "\"]");
                sourceNode.remove();
            });
            ssrcObj.ssrc.groups.forEach(function (group) {
                var groupNode = desc.find(">ssrc-group[semantics=\"" +
                    group.group.semantics + "\"]:has(source[ssrc=\"" +
                    group.primarySSRC +
                     "\"])");
                groupNode.remove();
            });
        });
    }

    ssrcs = this.modifiedSSRCs["addMuted"];
    this.modifiedSSRCs["addMuted"] = [];
    if(ssrcs && ssrcs.length) {
        ssrcs.forEach(function (ssrcObj) {
            var desc = createDescriptionNode(jingle, ssrcObj.mtype);
            var cname = Math.random().toString(36).substring(2);
            ssrcObj.ssrc.ssrcs.forEach(function (ssrc) {
                var sourceNode = desc.find(">source[ssrc=\"" +ssrc + "\"]");
                sourceNode.remove();
                var sourceXML = "<source " +
                    "xmlns=\"urn:xmpp:jingle:apps:rtp:ssma:0\" ssrc=\"" +
                    ssrc + "\">" +
                    "<parameter xmlns=\"urn:xmpp:jingle:apps:rtp:ssma:0\"" +
                    " value=\"" + ssrcObj.msid + "\" name=\"msid\"/>" +
                    "<parameter xmlns=\"urn:xmpp:jingle:apps:rtp:ssma:0\"" +
                    " value=\"" + cname + "\" name=\"cname\" />" + "</source>";
                desc.append(sourceXML);
            });
            ssrcObj.ssrc.groups.forEach(function (group) {
                var groupNode = desc.find(">ssrc-group[semantics=\"" +
                    group.group.semantics + "\"]:has(source[ssrc=\"" + group.primarySSRC +
                    "\"])");
                groupNode.remove();
                desc.append("<ssrc-group semantics=\"" +
                    group.group.semantics +
                    "\" xmlns=\"urn:xmpp:jingle:apps:rtp:ssma:0\"><source ssrc=\"" +
                    group.group.ssrcs.split(" ").join("\"/><source ssrc=\"") + "\"/>" +
                    "</ssrc-group>");
            });
        });
    }
};

/**
 * Fixes the outgoing jingle packets with action source-remove by removing the
 * nodes related to the muted streams, handles removing of muted stream
 * @param jingle the jingle packet that is going to be sent
 * @returns {boolean} true if the jingle has to be sent and false otherwise.
 */
JingleSessionPC.prototype.fixSourceRemoveJingle = function(jingle) {
    var ssrcs = this.modifiedSSRCs["mute"];
    this.modifiedSSRCs["mute"] = [];
    if(ssrcs && ssrcs.length)
        ssrcs.forEach(function (ssrcObj) {
            ssrcObj.ssrc.ssrcs.forEach(function (ssrc) {
                var sourceNode = $(jingle.tree()).find(">jingle>content[name=\"" +
                    ssrcObj.mtype + "\"]>description>source[ssrc=\"" +
                    ssrc + "\"]");
                sourceNode.remove();
            });
            ssrcObj.ssrc.groups.forEach(function (group) {
                var groupNode = $(jingle.tree()).find(">jingle>content[name=\"" +
                    ssrcObj.mtype + "\"]>description>ssrc-group[semantics=\"" +
                    group.group.semantics + "\"]:has(source[ssrc=\"" + group.primarySSRC +
                     "\"])");
                groupNode.remove();
            });
        });

    ssrcs = this.modifiedSSRCs["remove"];
    this.modifiedSSRCs["remove"] = [];
    if(ssrcs && ssrcs.length)
        ssrcs.forEach(function (ssrcObj) {
            var desc = createDescriptionNode(jingle, ssrcObj.mtype);
            ssrcObj.ssrc.ssrcs.forEach(function (ssrc) {
                var sourceNode = desc.find(">source[ssrc=\"" +ssrc + "\"]");
                if(!sourceNode || !sourceNode.length) {
                    //Maybe we have to include cname, msid, etc here?
                    desc.append("<source " +
                        "xmlns=\"urn:xmpp:jingle:apps:rtp:ssma:0\" ssrc=\"" +
                        ssrc + "\"></source>");
                }
            });
            ssrcObj.ssrc.groups.forEach(function (group) {
                var groupNode = desc.find(">ssrc-group[semantics=\"" +
                    group.group.semantics + "\"]:has(source[ssrc=\"" + group.primarySSRC +
                     "\"])");
                if(!groupNode || !groupNode.length) {
                    desc.append("<ssrc-group semantics=\"" +
                        group.group.semantics +
                        "\" xmlns=\"urn:xmpp:jingle:apps:rtp:ssma:0\"><source ssrc=\"" +
                        group.group.ssrcs.split(" ").join("\"/><source ssrc=\"") + "\"/>" +
                        "</ssrc-group>");
                }
            });
        });
};

/**
 * Returns the description node related to the passed content type. If the node
 * doesn't exists it will be created.
 * @param jingle - the jingle packet
 * @param mtype - the content type(audio, video, etc.)
 */
function createDescriptionNode(jingle, mtype) {
    var content = $(jingle.tree()).find(">jingle>content[name=\"" +
        mtype + "\"]");

    if(!content || !content.length) {
        $(jingle.tree()).find(">jingle").append(
            "<content name=\"" + mtype + "\"></content>");
        content = $(jingle.tree()).find(">jingle>content[name=\"" +
            mtype + "\"]");
    }

    var desc = content.find(">description");
    if(!desc || !desc.length) {
        content.append("<description " +
            "xmlns=\"urn:xmpp:jingle:apps:rtp:1\" media=\"" +
            mtype + "\"></description>");
        desc = content.find(">description");
    }
    return desc;
}

module.exports = JingleSessionPC;
