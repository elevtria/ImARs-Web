import assert from "node:assert/strict";
import test from "node:test";
import { activityPercent, assessmentPercent, summarizeAssessments, percentLabel, gainLabel } from "../js/activity-score.js";

test("activity score uses the stored score and maximum without inventing missing results", () => {
  assert.equal(activityPercent({ activityScore: 3, activityTotalQuestions: 4 }), 75);
  assert.equal(activityPercent({ activityScore: 0, activityTotalPoints: 10 }), 0);
  assert.equal(activityPercent({ preTestScore: 5, preTestTotalQuestions: 5 }), null);
  assert.equal(activityPercent({ activityScore: 11, activityTotalQuestions: 10 }), null);
  assert.equal(activityPercent({ activityScore: 2, activityTotalQuestions: 0 }), null);
});

test("assessment averages retain earned zeroes, exclude invalid or missing scores and weight completed assessments equally", () => {
  const pre = {isPreTestCompleted:true,preTestScore:0,preTestTotalQuestions:5};
  assert.equal(assessmentPercent(pre,"pre"),0);
  for(const row of [{},{...pre,isPreTestCompleted:false},{...pre,preTestScore:6},{...pre,preTestTotalQuestions:0},{...pre,preTestScore:Infinity}]) assert.equal(assessmentPercent(row,"pre"),null);
  const summary=summarizeAssessments([pre,{isPreTestCompleted:true,preTestScore:2,preTestTotalQuestions:2},{isPostTestCompleted:true,postTestHeatmap:[true,false,true],postTestTotalQuestions:4}]);
  assert.equal(summary.pre,50);assert.equal(summary.preCount,2);assert.equal(summary.post,50);assert.equal(summary.pairCount,0);assert.equal(summary.gain,null);
  assert.equal(percentLabel(0),"0%");assert.equal(percentLabel(null),"—");
});

test("learning gain uses matched lessons, keeps declines and rounds only after aggregation",()=>{
  const lesson={isPreTestCompleted:true,preTestScore:4,preTestTotalQuestions:5,isPostTestCompleted:true,postTestScore:5,postTestTotalQuestions:10};
  const summary=summarizeAssessments([lesson,{isPreTestCompleted:true,preTestScore:0,preTestTotalQuestions:5}]);
  assert.equal(summary.pre,40);assert.equal(summary.post,50);assert.equal(summary.gain,-30);assert.equal(summary.pairCount,1);
  assert.equal(gainLabel(summary.gain),"-30 pp");assert.equal(gainLabel(null),"—");assert.equal(gainLabel(15),"+15 pp");
});
