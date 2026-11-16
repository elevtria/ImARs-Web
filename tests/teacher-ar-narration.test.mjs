import assert from "node:assert/strict";
import test from "node:test";
import { TeacherARNarration } from "../js/teacher-ar-narration.js";

class Audio extends EventTarget {
  paused = true; currentTime = 0; attributes = new Map(); starts = [];
  set src(value) { this.attributes.set("src", value); }
  getAttribute(name) { return this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  load() {}
  pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
  async play() {
    if (this.rejectNext) { this.rejectNext = false; throw Error("Playback unavailable"); }
    this.paused = false; this.starts.push(this.getAttribute("src")); this.dispatchEvent(new Event("play"));
  }
  tick(time) { this.currentTime = time; this.dispatchEvent(new Event("timeupdate")); }
  end() { this.paused = true; this.dispatchEvent(new Event("ended")); }
}
const label = { id: "water", audio: "/description.mp3", interactiveAudio: "/current-question-answer.ogg", description: "The full description.",
  descriptionCues: [{ start: 0, text: "The first sentence." }, { start: 2, text: "The second sentence." }],
  question: "What happens next?", answer: "The water turns into vapor.", answerStart: 4 };
function setup() {
  const audio = new Audio(), subtitles = [], states = [], errors = [];
  const narration = new TeacherARNarration(audio, { onSubtitle: text => subtitles.push(text), onState: state => states.push(state), onError: () => errors.push(true) });
  return { audio, narration, subtitles, states, errors };
}

test("mobile narration plays description then the current question/answer clip with timed bottom captions", async () => {
  const app = setup(); await app.narration.start(label);
  assert.equal(app.audio.paused, false);
  assert.equal(app.subtitles.at(-1), "The first sentence.");
  app.audio.tick(2.1); assert.equal(app.subtitles.at(-1), "The second sentence.");
  app.audio.end();
  assert.equal(app.audio.getAttribute("src"), label.interactiveAudio);
  assert.equal(app.subtitles.at(-1), label.question);
  app.audio.tick(4); assert.equal(app.subtitles.at(-1), label.answer);
  app.audio.end();
  assert.equal(app.narration.label, null); assert.equal(app.audio.paused, true);
  assert.equal(app.subtitles.at(-1), "");
  assert.deepEqual(app.audio.starts, [label.audio, label.interactiveAudio]);
});

test("tapping another label or tapping again restarts one voice and clears the previous subtitles", async () => {
  const app = setup(); await app.narration.start(label);
  app.audio.tick(3); app.audio.end(); app.audio.tick(5);
  assert.equal(app.subtitles.at(-1), label.answer);
  await app.narration.start(label);
  assert.equal(app.audio.currentTime, 0); assert.equal(app.audio.getAttribute("src"), label.audio);
  assert.equal(app.subtitles.at(-1), label.descriptionCues[0].text);
  const next = { id: "next", audio: "/new-description.mp3", description: "A different description." };
  await app.narration.start(next);
  assert.equal(app.audio.getAttribute("src"), next.audio);
  assert.equal(app.subtitles.at(-1), next.description);
  app.narration.stop(); assert.equal(app.subtitles.at(-1), "");
  assert.equal(app.audio.getAttribute("src"), undefined);
});

test("pausing preserves narration position, mute stops the voice and captions, and unmute does not autoplay", async () => {
  const app = setup(); await app.narration.start(label); app.audio.tick(2.5);
  await app.narration.toggle(label); assert.equal(app.audio.paused, true);
  await app.narration.toggle(label); assert.equal(app.audio.paused, false); assert.equal(app.audio.currentTime, 2.5);
  app.narration.setMuted(true);
  assert.equal(app.audio.paused, true); assert.equal(app.subtitles.at(-1), "");
  assert.equal(await app.narration.start(label), false);
  app.narration.setMuted(false); assert.equal(app.audio.paused, true);
});

test("labels with only an interactive recording and playback errors are handled without stale subtitles", async () => {
  const app = setup(); await app.narration.start({ ...label, audio: null });
  assert.equal(app.audio.getAttribute("src"), label.interactiveAudio); assert.equal(app.subtitles.at(-1), label.question);
  app.audio.rejectNext = true;
  assert.equal(await app.narration.start(label), false);
  assert.equal(app.subtitles.at(-1), ""); assert.equal(app.errors.length, 1);
  assert.equal(app.narration.label, null);
});
