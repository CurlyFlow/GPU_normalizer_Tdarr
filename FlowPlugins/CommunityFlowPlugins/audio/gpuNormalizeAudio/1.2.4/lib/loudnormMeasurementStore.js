"use strict";

function createLoudnormMeasurementStore({ keyForPlan }) {
  const entries = new Map();
  const emptyEntry = () => ({ state: "empty", record: null, task: null, error: null });

  const keyFor = (planOrKey) => (typeof planOrKey === "string" ? planOrKey : keyForPlan(planOrKey));

  const getEntry = (key) => entries.get(key) || emptyEntry();

  const writeEntry = (key, patch) => {
    const current = getEntry(key);
    const next = { ...current, ...patch };
    entries.set(key, next);
    return next;
  };

  const publishRecord = (planOrKey, record, state = "ready") => {
    const key = keyFor(planOrKey);
    writeEntry(key, { state, record, task: null, error: null });
    return record;
  };

  const publishTask = (planOrKey, task, state = "pending") => {
    const key = keyFor(planOrKey);
    const trackedTask = Promise.resolve(task).then((record) => {
      const current = getEntry(key);
      if (current.task === trackedTask && !current.record) writeEntry(key, { state: "ready", record, task: null, error: null });
      return record;
    }, (err) => {
      const current = getEntry(key);
      if (current.task === trackedTask) writeEntry(key, { state: "failed", task: null, error: err });
      throw err;
    });
    writeEntry(key, { state, task: trackedTask, record: null, error: null });
    return trackedTask;
  };

  return {
    allTasks: () => Array.from(entries.values()).map((entry) => entry.task).filter(Boolean),
    getRecord: (planOrKey) => getEntry(keyFor(planOrKey)).record,
    getState: (planOrKey) => getEntry(keyFor(planOrKey)),
    getTask: (planOrKey) => getEntry(keyFor(planOrKey)).task,
    hasPendingOrReady: (planOrKey) => {
      const entry = getEntry(keyFor(planOrKey));
      return Boolean(entry.record || entry.task);
    },
    hasRecord: (planOrKey) => Boolean(getEntry(keyFor(planOrKey)).record),
    hasTask: (planOrKey) => Boolean(getEntry(keyFor(planOrKey)).task),
    keyFor,
    knownValuesForPlan: (plan, fallback = null) => {
      const record = getEntry(keyFor(plan)).record;
      return (record || {}).values || fallback;
    },
    publishCached: (planOrKey, record) => publishRecord(planOrKey, record, "ready"),
    publishCancelled: (planOrKey) => writeEntry(keyFor(planOrKey), { state: "cancelled", task: null }),
    publishFused: (planOrKey, record) => publishRecord(planOrKey, record, "ready"),
    publishRecord,
    publishTask,
  };
}

module.exports = {
  createLoudnormMeasurementStore,
};
