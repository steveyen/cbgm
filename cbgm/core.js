/* Core partition rebalance algorithms, no UI. */

function rebalanceMap(ctx, req) {
  return run(ctx, req,
             initPartitionModel,
             validatePartitionSettings,
             allocNextMap,
             planNextMap,
             validateNextMap);
}

function initPartitionModel(ctx, req) {
  req.warnings = [];
  req.partitionModel =
    ctx.getObj("partitionModel-" + req.wantPartitionParams.model).result;
  if (!req.partitionModel) {
    req.err = "error: missing partitionModel-" + req.wantPartitionParams.model;
    return;
  }
  req.mapStatePriority = {}; // Key is state name ("master"), val is priority int.
  req.partitionModelStates =
    sortDesc(_.reduce(req.partitionModel.states, function(a, s, stateName) {
          req.mapStatePriority[stateName] = s.priority;
          a.push(_.defaults(_.clone(s), { name: stateName }));
          return a;
        }, []),
      "priority");
}

function validatePartitionSettings(ctx, req) {
  req.nextBucketEvents = _.clone(req.prevBucketEvents);
  req.nextBucketEvents.events = sortDesc(req.nextBucketEvents.events || [], "when");

  req.lastPartitionParams = _.findWhere(req.nextBucketEvents.events,
                                        { class: "partitionParams" });
  if (req.lastPartitionParams) {
    req.err = _.reduce(["keyFunc", "model", "numPartitions"], function(r, k) {
        if (req.lastPartitionParams[k] != req.wantPartitionParams[k]) {
          return "partitionParams." + k + " not equal: " +
            req.lastPartitionParams[k] + " vs " + req.wantPartitionParams[k];
        }
        return r;
      }, null);
    if (req.err) {
      return;
    }
  }

  req.lastPartitionMap = _.findWhere(req.nextBucketEvents.events,
                                     { class: "partitionMap" });
  if (req.lastPartitionMap) {
    req.lastPartitions = partitionsWithNodeNames(req.lastPartitionMap.partitions,
                                                 req.lastPartitionMap.nodes);
  }

  req.deltaNodes = { added: _.difference(req.wantPartitionParams.nodes,
                                       (req.lastPartitionParams || {}).nodes),
                     removed: _.difference((req.lastPartitionParams || {}).nodes,
                                           req.wantPartitionParams.nodes) };
}

function allocNextMap(ctx, req) {
  req.nextPartitionMap =
    ctx.newObj("partitionMap", _.omit(req.wantPartitionParams, "class")).result;
  req.nextPartitionMap.partitions =
    keyFunc[req.wantPartitionParams.keyFunc].allocPartitions(req);
  req.nextPartitionMapNumPartitions =
    _.size(req.nextPartitionMap.partitions);
}

function planNextMap(ctx, req) {
  // Start by filling out nextPartitions same as lastPartitions, but
  // filter out the to-be-removed nodes.
  var lastPartitions = req.lastPartitions || {};
  var nextPartitions =
    _.object(_.map(req.nextPartitionMap.partitions, function(_, partitionId) {
          var lastPartition = lastPartitions[partitionId] || {};
          var nextPartition = removeNodesFromPartition(lastPartition,
                                                       req.deltaNodes.removed);
          return [partitionId, nextPartition];
        }));

  req.stateNodeCounts = countStateNodes(nextPartitions);

  // Run through the sorted partition states (master, slave, etc) that
  // have constraints and invoke assignStateToPartitions().
  _.each(req.partitionModelStates, function(s, sIndex) {
      var constraints =
        parseInt((req.wantPartitionParams.constraints || {})[s.name]) ||
        parseInt(s.constraints) || 0;
      if (constraints >= 0) {
        assignStateToPartitions(s.name, constraints);
      }
    });

  // Given a state and its constraints, for every partition, assign nodes.
  function assignStateToPartitions(state, constraints) {
    // Sort the partitions to help reach a better assignment.
    var partitionIds =
      _.sortBy(_.keys(nextPartitions).sort(), function(partitionId) {
        // First, favor partitions on nodes that are to-be-removed.
        var lastPartition = lastPartitions[partitionId] || {};
        if (!_.isEmpty(_.intersection(lastPartition[state],
                                      req.deltaNodes.removed))) {
          return 0;
        }
        // Then, favor partitions who haven't been assigned to any
        // newly added nodes yet for any state.
        if (_.isEmpty(_.intersection(_.flatten(_.values(nextPartitions[partitionId])),
                                     req.deltaNodes.added))) {
          return 1;
        }
        return 2;
      });

    nextPartitions =
      _.object(_.map(partitionIds, function(partitionId) {
            var partition = nextPartitions[partitionId];
            var nodesToAssign = findBestNodes(partitionId, partition,
                                              state, constraints);
            partition = removeNodesFromPartition(partition,
                                                 partition[state],
                                                 decStateNodeCounts);
            partition = removeNodesFromPartition(partition,
                                                 nodesToAssign,
                                                 decStateNodeCounts);
            partition[state] = nodesToAssign;
            incStateNodeCounts(state, nodesToAssign);
            return [partitionId, partition];
          }));
  }

  function findBestNodes(partitionId, partition, state, constraints) {
    var weights = req.nextPartitionMap.weights || {};
    var stateNodeCounts =
      req.stateNodeCounts[state] =
      req.stateNodeCounts[state] || {};
    var statePriority = req.mapStatePriority[state];
    var candidateNodes = req.nextPartitionMap.nodes;
    _.each(partition, function(sNodes, s) {
        // Filter out nodes of a higher priority state; e.g., if
        // we're assigning slaves, leave the masters untouched.
        if (req.mapStatePriority[s] > statePriority) {
          candidateNodes = _.difference(candidateNodes, sNodes);
        }
      });
    candidateNodes = _.sortBy(candidateNodes, scoreNode);
    candidateNodes = candidateNodes.slice(0, constraints);
    if (candidateNodes.length < constraints) {
      req.warnings.push("warning: could not meet constraints: " + constraints +
                        ", state: " + state +
                        ", partitionId: " + partitionId);
    }
    return candidateNodes;

    function scoreNode(node) {
      var isCurrent = _.contains(partition[state], node);
      var currentFactor = isCurrent ? -1 : 0;
      var r = stateNodeCounts[node] || 0;
      var w = weights[node] || 0;
      if (w > 0) {
        r = r / w;
      }
      r = r + currentFactor;
      return r;
    }
  }

  function incStateNodeCounts(state, nodes) {
    adjustStateNodeCounts(req.stateNodeCounts, state, nodes, 1);
  }
  function decStateNodeCounts(state, nodes) {
    adjustStateNodeCounts(req.stateNodeCounts, state, nodes, -1);
  }
  function adjustStateNodeCounts(stateNodeCounts, state, nodes, amt) {
    _.each(nodes, function(n) {
        var s = stateNodeCounts[state] = stateNodeCounts[state] || {};
        s[n] = (s[n] || 0) + amt;
        if (s[n] < 0 || s[n] > req.nextPartitionMapNumPartitions) {
          console.log("ERROR: adjustStateNodeCounts out of range" +
                      ", state: " + state + " node: " + n + " s[n]: " + s[n]);
        }
      });
  }

  req.nextPartitionMap.partitions = nextPartitions;
  req.nextPartitionMap.partitions =
    partitionsWithNodeIndexes(req.nextPartitionMap.partitions,
                              req.nextPartitionMap.nodes);
}

function validateNextMap(ctx, req) {
  // TODO: do real validation here.
  req.nextBucketEvents.events.unshift(req.wantPartitionParams);
  req.nextBucketEvents.events.unshift(req.nextPartitionMap);
}

// --------------------------------------------------------

// Returns partition with nodes removed.  Example, when removeNodes == ["a"],
//   before - partition: {"0": { "master": ["a"], "slave": ["b"] } }
//   after  - partition: {"0": { "master": [], "slave": ["b"] } }
function removeNodesFromPartition(partition, removeNodes, cb) {
  return _.object(_.map(partition, function(partitionNodes, state) {
        if (cb) {
          cb(state, _.intersection(partitionNodes, removeNodes));
        }
        return [state, _.difference(partitionNodes, removeNodes)];
      }));
}

// Converts node indexes to node names.  Example, with "nodes": ["a", "b"]:
//   before - "partitions": { "0": { "master": [0], "slave": [1] }, ... }
//   after  - "partitions": { "0": { "master": ["a"], "slave": ["b"] }, ... }
// Reverse of partitionsWithNodeIndexes().
function partitionsWithNodeNames(partitions, nodes) {
  return partitionsMap(partitions,
                       function(nodeIdx) { return nodes[nodeIdx]; });
}

// Converts node names to indexes.  Example, with node" == ["a", "b"]:
//   before - partitions: { "0": { "master": ["a"], "slave": ["b"] }, ... }
//   after  - partitions: { "0": { "master": [0], "slave": [1] }, ... }
// Reverse of partitionsWithNodeNames().
function partitionsWithNodeIndexes(partitions, nodes) {
  return partitionsMap(partitions,
                       function(nodeName) { return _.indexOf(nodes, nodeName); });
}

// Like map(), but runs f() on every nodes array in the partition.
// Example, with partitions == { "0": { "master": ["a"], "slave": ["b", "c"] } }
// then you'll see f(["a"]) and f(["b", "c"]).
function partitionsMap(partitions, f) {
  return _.object(_.map(partitions, function(partition, partitionId) {
        return [partitionId,
                _.object(_.map(partition, function(arr, state) {
                      return [state, _.map(arr, f)];
                    }))];
      }));
}

// Example, with partitions of...
//   { "0": { "master": ["a"], "slave": ["b", "c"] } },
//   { "1": { "master": ["b"], "slave": ["c"] } }
// then return value will be...
//   { "master": { "a": 1, "b": 1 } },
//   { "slave": { "b": 1, "c": 2 } }
function countStateNodes(partitions) {
  return _.reduce(partitions, function(r, partition, partitionId) {
      return _.reduce(partition, function(r, nodes, state) {
          _.each(nodes, function(node) {
              var s = r[state] = r[state] || {};
              s[node] = (s[node] || 0) + 1;
            });
          return r;
        }, r);
    }, {});
}

// --------------------------------------------------------

function run(ctx, req) { // Varargs are steps to apply to req as long as no req.err.
  return _.reduce(_.rest(arguments, 2), function(req, step) {
      return req.err ? req : step(ctx, req) || req;
    }, req);
}

function sortDesc(a, field) { return _.sortBy(a, field).reverse(); }
