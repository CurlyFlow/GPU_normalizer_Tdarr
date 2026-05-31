"use strict";

function createLoudnormMeasurementStore({ keyForPlan }) {
  const records = new Map();
  const tasks = new Map();
  const states = new Map();

  const keyFor = (planOrKey) => (typeof planOrKey === "string" ? planOrKey : keyForPlan(planOrKey));

  const writeState = (key, patch) => {
    const current = states.get(key) || { state: "empty", record: null, task: null };
    const next = { ...current, ...patch };
    states.set(key, next);
    return next;
  };

  const publishRecord = (planOrKey, record, state = "ready") => {
    const key = keyFor(planOrKey);
    records.set(key, record);
    writeState(key, { state, record, task: tasks.get(key) || null });
    return record;
  };

  const publishTask = (planOrKey, task, state = "pending") => {
    const key = keyFor(planOrKey);
    tasks.set(key, task);
    writeState(key, { state, task, record: records.get(key) || null });
    return task;
  };

  return {
    allTasks: () => Array.from(tasks.values()),
    getRecord: (planOrKey) => records.get(keyFor(planOrKey)),
    getState: (planOrKey) => states.get(keyFor(planOrKey)) || { state: "empty", record: null, task: null },
    getTask: (planOrKey) => tasks.get(keyFor(planOrKey)),
    hasPendingOrReady: (planOrKey) => {
      const key = keyFor(planOrKey);
      return records.has(key) || tasks.has(key);
    },
    hasRecord: (planOrKey) => records.has(keyFor(planOrKey)),
    hasTask: (planOrKey) => tasks.has(keyFor(planOrKey)),
    keyFor,
    knownValuesForPlan: (plan, fallback = null) => {
      const record = records.get(keyFor(plan));
      return (record || {}).values || fallback;
    },
    publishCached: (planOrKey, record) => publishRecord(planOrKey, record, "cached"),
    publishCancelled: (planOrKey) => writeState(keyFor(planOrKey), { state: "cancelled" }),
    publishFused: (planOrKey, record) => publishRecord(planOrKey, record, "fused"),
    publishRecord,
    publishTask,
  };
}

module.exports = {
  createLoudnormMeasurementStore,
};
