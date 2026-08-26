// 자기대국 워커 — 한 도전자를 평가해 결과만 돌려준다. 로직은 selfplay-eval.mjs 가 소유한다.
import { parentPort, workerData } from 'node:worker_threads';
import { makeEvaluator } from './selfplay-eval.mjs';

const duel = makeEvaluator(workerData);
parentPort.on('message', (task) => {
  const res = duel(task.cand, task.champ);
  parentPort.postMessage({ id: task.id, gd: res.gd, bad: res.bad });
});
