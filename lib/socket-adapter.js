var firepad = firepad || { };

firepad.SocketAdapter = (function (global) {

  var TextOperation = firepad.TextOperation;
  var utils = firepad.utils;

  function SocketAdapter (socket, userId, userColor, filename) {
    this.socket_ = socket;
    this.ready_ = false;
    this.socketCallbacks_ = [];
    this.zombie_ = false;
    this.userId_ = userId;
    this.filename_ = filename;

    // We store the current document state as a TextOperation so we can write checkpoints to Firebase occasionally.
    // TODO: Consider more efficient ways to do this. (composing text operations is ~linear in the length of the document).
    this.document_ = new TextOperation();

    // This is used for two purposes:
    // 1) On initialization, we fill this with the latest checkpoint and any subsequent operations and then
    //      process them all together.
    // 2) If we ever receive revisions out-of-order (e.g. rev 5 before rev 4), we queue them here until it's time
    //    for them to be handled. [this should never happen with well-behaved clients; but if it /does/ happen we want
    //    to handle it gracefully.]
    this.pendingReceivedRevisions_ = { };

    var self = this;

    this.setColor(userColor);
    this.sendCursor(null);

    // Once we're initialized, start tracking users' cursors.
    this.on('ready', function() {
      self.monitorCursors_();
    });

    // Avoid triggering any events until our callers have had a chance to attach their listeners.
    setTimeout(function() {
      self.monitorHistory_();
    }, 0);

  }
  utils.makeEventEmitter(SocketAdapter, ['ready', 'cursor', 'operation', 'ack', 'retry']);

  SocketAdapter.prototype.dispose = function() {
    var self = this;

    if (!this.ready_) {
      // TODO: this completes loading the text even though we're no longer interested in it.
      this.on('ready', function() {
	      self.dispose();
      });
      return;
    }

    this.removeSocketCallbacks_();

    this.socket_ = null;
    this.document_ = null;
    this.zombie_ = true;
  };

  SocketAdapter.prototype.isHistoryEmpty = function() {
    assert(this.ready_, "Not ready yet.");
    return this.revision_ === 0;
  };

  /*
   * Send operation, retrying on connection failure. Takes an optional callback with signature:
   * function(error, committed).
   * An exception will be thrown on transaction failure, which should only happen on
   * catastrophic failure like a security rule violation.
   */
  SocketAdapter.prototype.sendOperation = function (operation, callback) {
    var self = this;

    // If we're not ready yet, do nothing right now, and trigger a retry when we're ready.
    if (!this.ready_) {
      this.on('ready', function() {
        self.trigger('retry');
      });
      return;
    }

    // Sanity check that this operation is valid.
    assert(this.document_.targetLength === operation.baseLength, "sendOperation() called with invalid operation.");

    // Convert revision into an id that will sort properly lexicographically.
    var revisionId = revisionToId(this.revision_);

    this.sent_ = { id: revisionId, op: operation };
    this.socket_.emit('send-operation', {
        filename: self.filename_,
        operation: {
          id: revisionId,
          a: self.userId_,
          o: operation.toJSON()}
      }, callback);

  };

  SocketAdapter.prototype.sendCursor = function (obj) {
    let cursor = obj ? obj : {position: null, selectionEnd: null};
    if(!this.cursor_ || cursor.position !== null) {
      this.socket_.emit('send-cursor', {userId: this.userId_, cursor: cursor, color: this.color_});
    }
    this.cursor_ = cursor;
  };

  SocketAdapter.prototype.setColor = function(color) {
    this.color_ = color;
  };

  SocketAdapter.prototype.getDocument = function() {
    return this.document_;
  };

  SocketAdapter.prototype.registerCallbacks = function(callbacks) {
    for (var eventType in callbacks) {
      this.on(eventType, callbacks[eventType]);
    }
  };

  SocketAdapter.prototype.monitorCursors_ = function() {
    let self = this;
    this.socketOn_(this.socket_, 'receive-cursor', (cursor) => {
      self.trigger('cursor', cursor.id, {position: cursor.position, selectionEnd: cursor.selectionEnd}, cursor.color);
    })
  };

  SocketAdapter.prototype.monitorHistory_ = function() {
    var self = this;
    if (self.zombie_) { return; } // just in case we were cleaned up before we got the checkpoint data.

    // TODO Handle revisions in correct order
    function handleRevisionsIfReady() {
      if (self.ready_) {
        self.handlePendingReceivedRevisions_();
      }
    }

    function logOperation(operation) {
      self.pendingReceivedRevisions_[operation.docOpId] = { o: operation.ops, a: operation.author };
    }

    self.socketOn_(this.socket_, 'receive-operation', (operation) => {
      if (self.filename_ === operation.filename) {
        logOperation(operation);
        handleRevisionsIfReady();
      }
    });

    self.socket_.emit('ready-for-data', {filename: self.filename_, withCursors: true}, (operations, cursors) => {
      self.revision_ = revisionFromId(operations[0].docOpId);
      operations.forEach((operation) => {
        logOperation(operation);
      });
      self.handlePendingReceivedRevisions_();

      cursors.forEach((cursor) => {
        self.trigger('cursor', cursor.id, {position: cursor.position, selectionEnd: cursor.selectionEnd}, cursor.color);
      });

      self.ready_ = true;
      setTimeout(function() {
        self.trigger('ready');
      }, 0);
    });
    
  };

  SocketAdapter.prototype.handlePendingReceivedRevisions_ = function() {
    var pending = this.pendingReceivedRevisions_;
    var revisionId = revisionToId(this.revision_);
    var triggerRetry = false;
    while (pending[revisionId] != null) {
      this.revision_++;

      var revision = this.parseRevision_(pending[revisionId]);
      if (!revision) {
        // If a misbehaved client adds a bad operation, just ignore it.
        utils.log('Invalid operation.', revisionId, pending[revisionId]);
      } else {
        this.document_ = this.document_.compose(revision.operation);
        if (this.sent_ && revisionId === this.sent_.id) {
          // We have an outstanding change at this revision id.
          if (this.sent_.op.equals(revision.operation) && revision.author === this.userId_) {
            // This is our change; it succeeded.
            this.sent_ = null;
            this.trigger('ack');
          } else {
            // our op failed.  Trigger a retry after we're done catching up on any incoming ops.
            triggerRetry = true;
            this.trigger('operation', revision.operation);
          }
        } else {
          this.trigger('operation', revision.operation);
        }
      }
      delete pending[revisionId];

      revisionId = revisionToId(this.revision_);
    }

    if (triggerRetry) {
      this.sent_ = null;
      this.trigger('retry');
    }
  };

  SocketAdapter.prototype.parseRevision_ = function(data) {
    // We could do some of this validation via security rules.  But it's nice to be robust, just in case.
    if (typeof data !== 'object') { return null; }
    if (typeof data.a !== 'string' || typeof data.o !== 'object') { return null; }
    var op = null;
    try {
      op = TextOperation.fromJSON(data.o);
    }
    catch (e) {
      return null;
    }

    if (op.baseLength !== this.document_.targetLength) {
      return null;
    }
    return { author: data.a, operation: op }
  };

  SocketAdapter.prototype.socketOn_ = function(socket, eventType, callback, context) {
    this.socketCallbacks_.push({socket: socket, eventType: eventType, callback: callback, context: context });
    socket.on(eventType, callback, context);
    return callback;
  };

  SocketAdapter.prototype.socketOff_ = function(socket, eventType, callback, context) {
    socket.off(eventType, callback, context);
    for(var i = 0; i < this.socketCallbacks_.length; i++) {
      var l = this.socketCallbacks_[i];
      if (l.socket === socket && l.eventType === eventType && l.callback === callback && l.context === context) {
        this.socketCallbacks_.splice(i, 1);
        break;
      }
    }
  };

  SocketAdapter.prototype.removeSocketCallbacks_ = function() {
    for(var i = 0; i < this.socketCallbacks_.length; i++) {
      var l = this.socketCallbacks_[i];
      l.socket.off(l.eventType, l.callback, l.context);
    }
    this.socketCallbacks_ = [];
  };

  // Throws an error if the first argument is falsy. Useful for debugging.
  function assert (b, msg) {
    if (!b) {
      throw new Error(msg || "assertion error");
    }
  }

  // Based off ideas from http://www.zanopha.com/docs/elen.pdf
  var characters = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  function revisionToId(revision) {
    if (revision === 0) {
      return 'A0';
    }

    var str = '';
    while (revision > 0) {
      var digit = (revision % characters.length);
      str = characters[digit] + str;
      revision -= digit;
      revision /= characters.length;
    }

    // Prefix with length (starting at 'A' for length 1) to ensure the id's sort lexicographically.
    var prefix = characters[str.length + 9];
    return prefix + str;
  }

  function revisionFromId(revisionId) {
    assert (revisionId.length > 0 && revisionId[0] === characters[revisionId.length + 8]);
    var revision = 0;
    for(var i = 1; i < revisionId.length; i++) {
      revision *= characters.length;
      revision += characters.indexOf(revisionId[i]);
    }
    return revision;
  }

  return SocketAdapter;
}());
