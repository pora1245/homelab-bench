import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({entryPoints:['src/answerComparison.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {answerComparison} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const make=(scorer,answer,output,score={},meta={},prompt='')=>({status:'done',task:{id:'case:1',scorer,answer,meta,prompt},attempts:[{output,score}]});
let checks=0; const equal=(a,b)=>{assert.deepEqual(a,b);checks++};
const numeric=make('numeric','68','reason then #### 68',{detail:'최종 수치 추출: 68'});
equal(answerComparison(numeric).candidateText,'68');
equal(answerComparison(numeric).referenceText,'68');
const header = "The following are multiple choice questions (with answers) about law. Think step by step and output the answer as 'The answer is (X)' at the end.";
const prompt = header + "\n\nQuestion: demo\nOptions:\nA. wrong demo\nB. demo B\nThe answer is (B).\n\nQuestion: real clerk question\nOptions:\nA. first\nB. second\nAnswer: Let's think step by step.";
const c=make('choice','B','The answer is A.',{detail:'선택 답안: A'},{category:'law',demonstration_ids:[65]},prompt);
c.task.id='mmlu-pro:1388';
equal(answerComparison(c).candidateText,'A');equal(answerComparison(c).referenceText,'B. second');
equal(answerComparison(c).candidateLabel,'모델 선택');equal(answerComparison(c).referenceLabel,'기준 정답');
const builtQuestion = await build({entryPoints:['src/questionPresentation.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {questionPresentation} = await import(`data:text/javascript;base64,${Buffer.from(builtQuestion.outputFiles[0].text).toString('base64')}`);
equal(questionPresentation(c.task).text, 'real clerk question\nOptions:\nA. first\nB. second');
equal(questionPresentation(c.task).fullPrompt, prompt);
for (const task of [
 {...c.task,prompt:prompt.replace('real clerk question','real clerk question\n\nQuestion: embedded')},
 {...c.task,prompt:prompt.replace('real clerk question','real Question: embedded')},
 {...c.task,meta:{...c.task.meta,demonstration_ids:[65,66]}},
 {...c.task,prompt:prompt+'\n'},
 {...c.task,prompt:prompt.replace('B. second','C. second')},
 {...c.task,id:'custom:1388'},
 {...c.task,meta:{}},
]) {
 equal(questionPresentation(task).text, task.prompt);
 equal(questionPresentation(task).fullPrompt, null);
 equal(answerComparison({...c,task}).candidateText,'A');
}
equal(answerComparison(make('math','12','answer 12',{extra:{candidate_parsed:'[]'}})).candidateText,'수식 추출 실패');
equal(answerComparison(make('math','12','answer 12')).candidateText,'채점 수식 기록 없음');
equal(answerComparison(make('bbh','yes','The answer is yes.',{extra:{extracted_answer:'yes'}})).candidateText,'yes');
equal(answerComparison(make('json',{key:68},'{"other":68}')).candidateText,'{\n  "other": 68\n}');
equal(answerComparison(make('ifeval','all','response',{extra:{strict:[true,false]}},{instruction_id_list:['punctuation:no_comma','startend:quotation'],kwargs:[{},{}]})).candidateText,'1. 충족\n2. 불충족');
equal(answerComparison(make('livecodebench','tests','code',{state:'scored',value:0,extra:{test_results:[true,false,1,-1]}})).candidateText,'2 / 4 테스트 통과');
equal(answerComparison({...numeric,status:'running'}).referenceText,'답변 완료 후 표시');
const original=JSON.stringify(c);answerComparison(c);equal(JSON.stringify(c),original);
// The model side must use saved grading evidence, not the reference or option
// text. Even a contradictory raw output cannot overwrite the saved selection.
const independent=make('choice','B','The answer is B. second',
  {state:'scored',value:0,extra:{extracted_answer:'A'}},{options:['first','second']});
const independentBefore=JSON.stringify(independent),independentView=answerComparison(independent);
equal(independentView.candidateText,'A');equal(independentView.referenceText,'B. second');
equal(independentView.showFullOutput,true);equal(JSON.stringify(independent),independentBefore);
const noExtraction=make('choice','A','The answer is A.',{}, {options:['first','second']});
equal(answerComparison(noExtraction).candidateText,'채점 추출값 없음');
equal(answerComparison(noExtraction).referenceText,'A. first');
const longOption='A detailed reference option. '.repeat(5);
const selectedLong=make('choice','A','A',{state:'scored',value:1,extra:{extracted_answer:'A'}},{options:[longOption]});
equal(answerComparison(selectedLong).referenceText,`A. ${longOption}`);
equal(answerComparison(selectedLong).candidateText,'A');
equal(Boolean(answerComparison(selectedLong).sameLongAnswer),false);

// Condensing identical long answers is presentation only, and requires an
// explicit fully correct grade. Keep access to the complete original output.
const long='x'.repeat(80);
const matching=make('exact',long,long,{state:'scored',value:1});
const matchingBefore=JSON.stringify(matching),matchingView=answerComparison(matching);
equal(matchingView.sameLongAnswer,true);equal(matchingView.referenceText,long);
equal(matchingView.candidateText,long);equal(matchingView.showFullOutput,true);
equal(JSON.stringify(matching),matchingBefore);
equal(Boolean(answerComparison(make('exact','x'.repeat(79),'x'.repeat(79),{state:'scored',value:1})).sameLongAnswer),false);
for(const score of [{state:'scored',value:0},{state:'scored',value:0.5},{state:'unavailable',value:1},{value:1},{}]) {
  const record=make('exact',long,long,score),before=JSON.stringify(record);
  equal(Boolean(answerComparison(record).sameLongAnswer),false);
  equal(answerComparison(record).showFullOutput,true);equal(JSON.stringify(record),before);
}
equal(Boolean(answerComparison(make('exact',long,long+'y',{state:'scored',value:1})).sameLongAnswer),false);
equal(Boolean(answerComparison({...matching,status:'running'}).sameLongAnswer),false);
// Early-return scorer paths obey the same rule; mathematically equivalent
// expressions must remain separate when their saved representations differ.
for(const record of [
  make('numeric',long,'Original explanation',{state:'scored',value:1,extra:{extracted_answer:long}}),
  make('math',long,'Original proof',{state:'scored',value:1,extra:{candidate_parsed:long}}),
  make('bbh',long,'Original reasoning',{state:'scored',value:1,extra:{extracted_answer:long}}),
]) {
  const before=JSON.stringify(record),view=answerComparison(record);
  equal(view.sameLongAnswer,true);equal(view.showFullOutput,true);equal(JSON.stringify(record),before);
}
const fractionSum=Array(8).fill('\\frac{1}{2}').join('+');
const equivalentMath=make('math',fractionSum,'The result is 4.',{state:'scored',value:1,extra:{candidate_parsed:'4'}});
equal(answerComparison(equivalentMath).referenceText,fractionSum);equal(answerComparison(equivalentMath).candidateText,'4');
equal(Boolean(answerComparison(equivalentMath).sameLongAnswer),false);
console.log(`${checks} answer presentation checks passed; original records unchanged.`);
