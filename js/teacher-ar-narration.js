// Matches the mobile app: description, then its question/answer recording.
export class TeacherARNarration {
  constructor(audio, { onSubtitle, onState, onError }) {
    Object.assign(this, { audio, onSubtitle, onState, onError });
    this.version = 0; this.label = null; this.phase = null; this.muted = false;
    audio.addEventListener("timeupdate", () => this.updateSubtitle());
    audio.addEventListener("seeked", () => this.updateSubtitle());
    audio.addEventListener("play", () => { this.updateSubtitle(); onState(true); });
    audio.addEventListener("pause", () => onState(false));
    audio.addEventListener("ended", () => {
      if (!this.label) return;
      if (this.phase === "description" && this.label.interactiveAudio) void this.playClip("interactive");
      else this.stop();
    });
    audio.addEventListener("error", () => {
      if (!this.label) return;
      this.stop(); onError();
    });
  }
  async start(label) {
    this.stop();
    if (this.muted || !label || !(label.audio || label.interactiveAudio)) return false;
    this.label = label;
    return this.playClip(label.audio ? "description" : "interactive");
  }
  async playClip(phase) {
    const label = this.label;
    if (!label || this.muted) return false;
    const version = ++this.version;
    this.phase = phase;
    this.audio.src = phase === "description" ? label.audio : label.interactiveAudio;
    this.audio.currentTime = 0;
    this.updateSubtitle();
    try {
      await this.audio.play();
      return version === this.version;
    } catch {
      if (version === this.version) { this.stop(); this.onError(); }
      return false;
    }
  }
  updateSubtitle() {
    if (!this.label || this.muted) { this.onSubtitle(""); return; }
    const time = Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
    if (this.phase === "interactive") {
      this.onSubtitle(time >= this.label.answerStart && this.label.answer ? this.label.answer : this.label.question);
      return;
    }
    const cues = this.label.descriptionCues || [];
    if (!cues.length) { this.onSubtitle(this.label.description); return; }
    let text = "";
    for (const cue of cues) { if (cue.start > time) break; text = cue.text; }
    this.onSubtitle(text);
  }
  async toggle(label) {
    if (this.muted) return;
    if (!this.label || this.label.id !== label?.id) { await this.start(label); return; }
    if (!this.audio.paused) { this.audio.pause(); return; }
    const version = this.version;
    try { await this.audio.play(); }
    catch { if (version === this.version) { this.stop(); this.onError(); } }
  }
  stop() {
    this.version++; this.label = null; this.phase = null;
    this.audio.pause(); this.audio.removeAttribute("src"); this.audio.load();
    this.onSubtitle(""); this.onState(false);
  }
  setMuted(value) {
    this.muted = value; this.audio.muted = value;
    if (value) this.stop();
  }
}
