-- 066_leadership_principles.sql
-- Curated 2026 leadership-principles ontology for the Bar Raiser coach stage.
-- Global reference data (no user_id, no RLS), frozen snapshot, idempotent
-- re-seed. Mirrors 065_system_design_concerns. Maps a candidate's project
-- evidence to a company's leadership principles. 16 Amazon LPs + a generic
-- fallback set. Content is curated for what each principle ACTUALLY means and
-- how it is evaluated in an interview, not marketing copy.
BEGIN;

CREATE TABLE IF NOT EXISTS leadership_principles (
    principle_id     TEXT PRIMARY KEY,            -- 'amazon.customer_obsession'
    framework        TEXT NOT NULL,               -- 'amazon' | 'generic'
    name             TEXT NOT NULL,
    interpretation   TEXT NOT NULL,               -- what it ACTUALLY means (not marketing)
    signal_keywords  JSONB NOT NULL DEFAULT '[]'::jsonb,
    story_shapes     JSONB NOT NULL DEFAULT '[]'::jsonb,
    probing_patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
    failure_modes    JSONB NOT NULL DEFAULT '[]'::jsonb,
    display_order    SMALLINT NOT NULL DEFAULT 0,
    source           TEXT NOT NULL,
    as_of            DATE NOT NULL
);

INSERT INTO leadership_principles
    (principle_id, framework, name, interpretation, signal_keywords, story_shapes,
     probing_patterns, failure_modes, display_order, source, as_of) VALUES

('amazon.customer_obsession', 'amazon', 'Customer Obsession',
 'Start from the customer and work backwards; obsess over earning and keeping trust rather than over competitors. Evaluated on whether you can name the specific customer, the actual problem in their words, and a decision you made against your own convenience or local metric in their favour.',
 '["customer","user feedback","work backwards","support ticket","churn","nps","adoption","customer impact","usability","complaint","retention","onboarding"]'::jsonb,
 '["You changed a roadmap or design after watching/listening to real users, against your initial preference","You absorbed cost or extra work to fix a customer-facing problem others called acceptable"]'::jsonb,
 '["Who exactly was the customer, and how did you learn what they needed?","What did you give up (time, elegance, a metric) to serve them?","How did you know it actually helped them, not just that you shipped it?"]'::jsonb,
 '["talks about the product but never names a real customer or their words","conflates internal stakeholders with end customers","claims customer impact with no before/after signal"]'::jsonb,
 1, 'curated-2026', '2026-06-05'),

('amazon.ownership', 'amazon', 'Ownership',
 'Act on behalf of the whole company, not just your task; own outcomes end to end including the parts nobody assigned you. The strongest signal is operating the thing you built — on-call, incidents, postmortems — and fixing root causes instead of handing problems off with "that is not my team".',
 '["incident","on-call","postmortem","took ownership","end to end","operational","root cause","runbook","sev","follow-through","beyond my scope","long term"]'::jsonb,
 '["You owned a problem outside your formal remit because it would otherwise fall through the cracks","You ran the operational lifecycle of something you built and drove a permanent fix after an incident"]'::jsonb,
 '["What was technically not your job here, and why did you take it anyway?","What did the long-term fix look like versus the quick patch, and which did you do?","What happened when it broke at 3am — who got paged and what did you change so it would not recur?"]'::jsonb,
 '["frames ownership as just doing assigned tasks well","stops at shipping with no operational/maintenance story","blames another team instead of describing what they drove"]'::jsonb,
 2, 'curated-2026', '2026-06-05'),

('amazon.invent_and_simplify', 'amazon', 'Invent and Simplify',
 'Seek new ideas from everywhere and reduce complexity rather than add it; being externally aware so you are not reinventing. Evaluated on a non-obvious solution AND a deliberate simplification — removing a system, collapsing steps, deleting code — not just building something new.',
 '["simplify","redesign","reduce complexity","novel","prototype","automation","eliminate","consolidate","deprecate","remove","invented","streamline"]'::jsonb,
 '["You replaced a complex/manual process with a simpler design and can quantify what got removed","You invented a non-obvious approach after rejecting the default solution"]'::jsonb,
 '["What was the obvious solution, and why did you reject it?","What did you remove or simplify, and how do you know it was actually simpler for users/operators?","Where did the idea come from — what outside source informed it?"]'::jsonb,
 '["adds a new system but never simplifies anything","calls routine work novel","complexity reduction asserted with no concrete thing removed"]'::jsonb,
 3, 'curated-2026', '2026-06-05'),

('amazon.are_right_a_lot', 'amazon', 'Are Right A Lot',
 'Have strong judgement and good instincts, seek diverse perspectives, and work to disconfirm your own beliefs. The signal is calibrated judgement under uncertainty — a decision made on incomplete data that you can defend — plus evidence you actively looked for ways you were wrong.',
 '["judgement","decision","tradeoff","data-informed","hypothesis","seek perspectives","disconfirm","calibration","intuition","weighed options","wrong"]'::jsonb,
 '["You made a high-stakes call with incomplete information and it held up, and you can explain the reasoning","You changed your mind after seeking a dissenting view and the outcome was better for it"]'::jsonb,
 '["What information did you have versus need, and how did you decide anyway?","Whose perspective did you seek that disagreed with you?","Looking back, was the decision right because of judgement or luck — how do you know?"]'::jsonb,
 '["presents only decisions that worked, never the reasoning","never sought a contrary view","confuses being confident with being right"]'::jsonb,
 4, 'curated-2026', '2026-06-05'),

('amazon.learn_and_be_curious', 'amazon', 'Learn and Be Curious',
 'Never stop learning and seek to improve yourself; explore new possibilities and act on curiosity. Evaluated on self-directed learning that changed how you worked — you picked up an unfamiliar technology or domain because the problem demanded it, not because someone assigned a course.',
 '["learned","self-taught","new technology","unfamiliar","explored","curiosity","deep dive","upskilled","experiment","read the source","picked up"]'::jsonb,
 '["You taught yourself an unfamiliar technology/domain to solve a real problem and shipped with it","You went deep on how something worked out of curiosity and it later paid off"]'::jsonb,
 '["What did you not know at the start, and how did you close that gap?","Why learn it yourself rather than hand it to someone who already knew?","What did the learning let you do that you could not before?"]'::jsonb,
 '["lists technologies used with no story of learning anything new","learning was assigned/passive, not self-directed","curiosity claimed but no concrete exploration"]'::jsonb,
 5, 'curated-2026', '2026-06-05'),

('amazon.hire_and_develop_the_best', 'amazon', 'Hire and Develop the Best',
 'Raise the performance bar with every hire and promotion, and develop others through coaching and feedback. For individual contributors the signal is mentoring, unblocking, or levelling up teammates — and sometimes giving hard feedback — not formal management authority.',
 '["mentored","onboarded","coached","feedback","pairing","raised the bar","grew the team","interview","developed","unblocked","taught"]'::jsonb,
 '["You mentored or coached someone and can point to how they grew because of it","You gave difficult, direct feedback that improved a teammate or a hiring outcome"]'::jsonb,
 '["Who did you develop, and what could they do after that they could not before?","Did you ever give feedback that was hard to deliver — what and how?","How did you raise the bar rather than just fill a seat?"]'::jsonb,
 '["claims mentoring but describes only answering occasional questions","no evidence the other person actually grew","avoids any mention of hard feedback"]'::jsonb,
 6, 'curated-2026', '2026-06-05'),

('amazon.insist_on_the_highest_standards', 'amazon', 'Insist on the Highest Standards',
 'Hold a relentlessly high bar that many think is unreasonably high, and refuse to let defects pass downstream. Evaluated on a concrete instance where you raised quality — tests, review rigour, reliability, a refusal to ship — even when it cost time and was unpopular.',
 '["quality bar","code review","testing","refused to ship","standard","defect","raised the bar","rigor","linting","coverage","no broken windows"]'::jsonb,
 '["You held the line on quality (blocked a release, demanded tests) despite schedule pressure, and it paid off","You drove a standard — review rigour, test coverage, reliability target — that the team adopted"]'::jsonb,
 '["What was the standard, and why was it higher than what the team accepted?","What did insisting on it cost you, and was it worth it?","How did you make the standard stick beyond the one instance?"]'::jsonb,
 '["describes generic good practices with no moment of holding the line","high standards claimed but defects shipped anyway","standard set for self only, never propagated"]'::jsonb,
 7, 'curated-2026', '2026-06-05'),

('amazon.think_big', 'amazon', 'Think Big',
 'Create and communicate a bold direction that inspires results; think differently and look around corners. The signal is a vision beyond the immediate ask — you designed for an order-of-magnitude bigger future or reframed the problem — while still grounding it in something you actually delivered.',
 '["vision","long term","10x","scalable","reframed","strategic","bold","platform","beyond the ask","future-proof","bigger picture"]'::jsonb,
 '["You reframed a narrow task into a bigger opportunity and pursued the larger version","You designed deliberately for a much larger scale/scope than currently required and it later mattered"]'::jsonb,
 '["What was the small version of this, and why did you go bigger?","How did you communicate the vision so others bought in?","How did you avoid over-building — where was the line between bold and wasteful?"]'::jsonb,
 '["confuses thinking big with over-engineering","bold vision with nothing actually built toward it","just did the task as scoped, no larger framing"]'::jsonb,
 8, 'curated-2026', '2026-06-05'),

('amazon.bias_for_action', 'amazon', 'Bias for Action',
 'Speed matters; value calculated risk-taking and decisions/actions that are reversible without extensive study. Evaluated on shipping or unblocking quickly under uncertainty — a two-way-door decision you made fast — while showing you knew which risks were reversible and which were not.',
 '["shipped fast","prototype","unblocked","reversible","two-way door","moved quickly","calculated risk","mvp","iterate","decided without full data","momentum"]'::jsonb,
 '["You moved fast on a reversible decision and unblocked progress instead of waiting for certainty","You shipped a lean version to learn, then iterated, rather than over-planning"]'::jsonb,
 '["How did you decide it was safe to move without more data?","Was this reversible — how did you know, and would you move that fast on a one-way door?","What did moving fast cost, and how did you contain the downside?"]'::jsonb,
 '["recklessness framed as speed (acted fast on an irreversible high-stakes call)","analysis-paralysis dressed up as diligence","no notion of reversible vs irreversible"]'::jsonb,
 9, 'curated-2026', '2026-06-05'),

('amazon.frugality', 'amazon', 'Frugality',
 'Accomplish more with less; constraints breed resourcefulness, self-sufficiency, and invention — no points for headcount, budget, or fixed expense. The engineering signal is delivering with limited resources, cutting cost without cutting outcomes, or choosing a cheaper approach that worked just as well.',
 '["cost","budget","resourceful","reduced spend","free tier","reused","constraint","efficient","cheaper alternative","did more with less","optimized cost","scale to zero"]'::jsonb,
 '["You delivered a real outcome under tight resource/budget constraints by being resourceful","You cut infrastructure or operating cost significantly without degrading the result"]'::jsonb,
 '["What was the constraint, and how did it change your approach?","What was the cheaper path you took, and what did you give up — if anything?","How do you know the savings were real and the outcome held?"]'::jsonb,
 '["equates frugality with cutting corners that hurt the outcome","claims cost savings with no figure or baseline","spent freely and calls it efficient"]'::jsonb,
 10, 'curated-2026', '2026-06-05'),

('amazon.earn_trust', 'amazon', 'Earn Trust',
 'Listen attentively, speak candidly, treat others respectfully, and be vocally self-critical even when awkward; benchmark yourself against the best. The signal is owning a mistake openly, giving honest status (including bad news), and building credibility through consistent follow-through.',
 '["admitted","mistake","candid","transparent","apologized","self-critical","credibility","honest","trust","follow-through","communicated risk","owned the failure"]'::jsonb,
 '["You openly owned a mistake, communicated it early, and fixed it — earning rather than losing trust","You gave hard, candid news (a slip, a risk) to stakeholders instead of hiding it"]'::jsonb,
 '["What is something you got wrong here, and how did you handle telling people?","How did you deliver bad news — and what did that do to the relationship?","How did people come to trust your word over time?"]'::jsonb,
 '["no mistake ever admitted; everything went well","candour claimed but only flattering details shared","hid or delayed bad news"]'::jsonb,
 11, 'curated-2026', '2026-06-05'),

('amazon.dive_deep', 'amazon', 'Dive Deep',
 'Operate at all levels, stay connected to the details, audit frequently, and be skeptical when metrics and anecdote diverge; no task is beneath you. The signal is going below the abstraction — reading logs, profiling, tracing, querying raw data — to find a true root cause others missed.',
 '["root cause","logs","profiling","traced","debugged","metrics","audited","reproduced","raw data","drilled down","instrumented","read the source"]'::jsonb,
 '["You dug below the surface (logs, traces, raw data) to find a non-obvious root cause others stopped short of","You distrusted a metric/anecdote and verified the real numbers yourself"]'::jsonb,
 '["How far down did you actually go — what did you read or measure directly?","Where did the obvious explanation turn out wrong, and how did you find the real cause?","What detail did everyone else miss, and why?"]'::jsonb,
 '["stops at the symptom or the first plausible cause","relies on others summary instead of looking themselves","claims root cause with no detail of how it was found"]'::jsonb,
 12, 'curated-2026', '2026-06-05'),

('amazon.have_backbone_disagree_and_commit', 'amazon', 'Have Backbone; Disagree and Commit',
 'Respectfully challenge decisions you disagree with even when uncomfortable; do not compromise for social cohesion — but once a decision is made, commit fully. The signal is BOTH halves: you pushed back with reasoning, AND you committed wholeheartedly when overruled.',
 '["disagreed","pushed back","challenged","committed anyway","escalated","conviction","overruled","backbone","made the case","then fully supported","aligned"]'::jsonb,
 '["You disagreed with a decision, made your case directly, were overruled, then committed fully and made it succeed","You challenged a popular direction with evidence despite social pressure"]'::jsonb,
 '["What did you disagree with, and how directly did you say so — to whom?","When the decision went against you, what did you actually do next?","How do you distinguish principled disagreement from just being difficult?"]'::jsonb,
 '["disagreed but never committed (kept undermining)","committed but never actually voiced the disagreement","frames stubbornness as backbone"]'::jsonb,
 13, 'curated-2026', '2026-06-05'),

('amazon.deliver_results', 'amazon', 'Deliver Results',
 'Focus on the key inputs and deliver them with the right quality and in a timely fashion; rise to the occasion and never settle despite setbacks. Evaluated on a concrete shipped outcome with a measurable result, AND how you overcame a real obstacle to get there.',
 '["delivered","shipped","launched","on time","despite","overcame","hit the goal","measurable","results","unblocked the launch","met the deadline","outcome"]'::jsonb,
 '["You delivered a meaningful result despite a serious setback, and can quantify the outcome","You identified the key inputs and drove them to completion under a real deadline"]'::jsonb,
 '["What did you actually deliver, and what was the measurable result?","What setback nearly derailed it, and how did you push through?","What were the key inputs you focused on versus the noise you ignored?"]'::jsonb,
 '["describes effort/activity with no delivered outcome","no measurable result, only that it was done","setbacks omitted, so resilience cannot be assessed"]'::jsonb,
 14, 'curated-2026', '2026-06-05'),

('amazon.earths_best_employer', 'amazon', 'Strive to be Earth''s Best Employer',
 'Work to make the workplace safer, more productive, more diverse, and more just; lead with empathy, have fun, and make it easy for others to have fun too. For engineers the signal is improving the team''s working environment — reducing toil, improving inclusion, mentoring, or psychological safety — not just shipping features.',
 '["team health","reduced toil","inclusive","psychological safety","empathy","developer experience","mentoring","work environment","burnout","made it easier","onboarding"]'::jsonb,
 '["You improved the team''s environment or developer experience (cut toil, improved inclusion/safety) measurably","You led with empathy through a hard period and the team came out stronger"]'::jsonb,
 '["What did you change that made the team better off, not just the product?","How did you know it actually helped people, not just felt good?","What did you do when someone was struggling or excluded?"]'::jsonb,
 '["only feature delivery, nothing about people or environment","empathy asserted with no concrete action","improvement claimed with no signal it landed"]'::jsonb,
 15, 'curated-2026', '2026-06-05'),

('amazon.success_and_scale_broad_responsibility', 'amazon', 'Success and Scale Bring Broad Responsibility',
 'Recognise that decisions have consequences beyond the immediate goal — for society, the planet, security, privacy, and future users — and act with humility and care. The engineering signal is considering second-order effects: security, privacy, abuse, accessibility, cost-to-society, or long-term maintenance burden.',
 '["security","privacy","accessibility","abuse","second-order","unintended consequence","sustainability","responsible","data protection","long-term impact","duty of care","compliance"]'::jsonb,
 '["You weighed the broader consequences (security, privacy, abuse, accessibility) and changed the design accordingly","You anticipated an unintended harm at scale and built a safeguard before it bit"]'::jsonb,
 '["What second-order effects did you consider beyond making it work?","How could this be misused or harm someone at scale, and what did you do about it?","What did you choose to do that was harder but more responsible?"]'::jsonb,
 '["considers only the happy path, no broader consequences","mentions security/privacy as an afterthought with no action","treats scale as purely a performance problem"]'::jsonb,
 16, 'curated-2026', '2026-06-05'),

('generic.leadership', 'generic', 'Leadership',
 'Influencing outcomes and people without necessarily having authority — setting direction, taking responsibility, and getting others to follow. Evaluated on a moment you stepped up: drove a decision, rallied people, or owned an outcome others would not.',
 '["led","drove","initiative","took charge","rallied","owned the outcome","set direction","influenced","without authority","stepped up"]'::jsonb,
 '["You stepped into a leadership vacuum and drove an outcome others would not own","You influenced a team or decision without formal authority"]'::jsonb,
 '["What did you lead, and what would have happened if you had not stepped in?","How did you get people to follow when you had no authority over them?","What did you own when it went wrong?"]'::jsonb,
 '["describes being assigned a lead title with no actual leadership act","took credit for a team effort with no personal leadership signal"]'::jsonb,
 1, 'curated-2026', '2026-06-05'),

('generic.decision_making', 'generic', 'Decision Making',
 'Making sound, defensible decisions under uncertainty and trade-offs, and owning the consequences. Evaluated on the reasoning: what options you weighed, what data you had versus needed, and how you decided when the answer was not obvious.',
 '["decision","tradeoff","weighed options","under uncertainty","data-informed","chose","prioritized","judgement","pros and cons","decided"]'::jsonb,
 '["You made a hard call between genuine trade-offs and can defend the reasoning","You decided under real uncertainty and owned how it turned out"]'::jsonb,
 '["What were the real alternatives, and why did you pick this one?","What did you not know, and how did you decide anyway?","Would you make the same call again — why?"]'::jsonb,
 '["presents only the chosen option with no alternatives considered","decision was obvious, no real trade-off","outcome described but not the reasoning"]'::jsonb,
 2, 'curated-2026', '2026-06-05'),

('generic.conflict', 'generic', 'Handling Conflict',
 'Navigating disagreement with people or priorities productively — surfacing the issue, hearing the other side, and reaching a workable resolution without damaging the relationship. Evaluated on a real disagreement and how you moved it to resolution.',
 '["disagreement","conflict","resolved","compromise","aligned","pushed back","heard them out","tension","negotiated","found common ground"]'::jsonb,
 '["You had a substantive disagreement with a colleague/stakeholder and resolved it constructively","You mediated or de-escalated a conflict and reached a workable outcome"]'::jsonb,
 '["What was the disagreement actually about, and what was the other person''s view?","How did you move from conflict to resolution?","What did you concede, and what did you hold firm on?"]'::jsonb,
 '["describes a conflict with no resolution or follow-through","frames the other party entirely at fault","avoided the conflict rather than addressing it"]'::jsonb,
 3, 'curated-2026', '2026-06-05'),

('generic.growth', 'generic', 'Growth and Learning',
 'Actively developing your own skills and adapting when the situation demands something you did not already know. Evaluated on self-directed learning that changed your work and on how you respond to feedback and failure.',
 '["learned","self-taught","feedback","grew","adapted","unfamiliar","improved","upskilled","mistake","new skill","reflected"]'::jsonb,
 '["You taught yourself something new to meet a real need and applied it","You took hard feedback or a failure and visibly changed because of it"]'::jsonb,
 '["What did you have to learn that you did not know, and how?","What feedback changed how you work?","What did a failure teach you, concretely?"]'::jsonb,
 '["lists skills with no story of acquiring them","claims growth with no behaviour change","defensive about feedback or failure"]'::jsonb,
 4, 'curated-2026', '2026-06-05'),

('generic.impact', 'generic', 'Impact and Results',
 'Delivering outcomes that matter and being able to show the result, not just the effort. Evaluated on a concrete shipped result with a measurable effect and your specific contribution to it.',
 '["delivered","shipped","result","measurable","impact","outcome","improved","reduced","increased","launched","drove the result"]'::jsonb,
 '["You delivered a result with a measurable effect and can isolate your own contribution","You drove a meaningful outcome through to completion despite obstacles"]'::jsonb,
 '["What was the measurable result, and what part was specifically yours?","How do you know the impact was real and not coincidence?","What obstacle did you overcome to deliver it?"]'::jsonb,
 '["describes activity/effort with no outcome","no measurable result, just that work happened","cannot separate own contribution from the team''s"]'::jsonb,
 5, 'curated-2026', '2026-06-05'),

('generic.integrity', 'generic', 'Integrity and Trust',
 'Being honest, owning mistakes, and acting consistently with what you say — including delivering uncomfortable truths. Evaluated on owning a mistake openly and on giving candid information when it would have been easier to stay quiet.',
 '["honest","admitted","mistake","transparent","candid","owned it","trust","integrity","told the truth","self-critical","raised the concern"]'::jsonb,
 '["You owned a mistake openly and dealt with the consequences rather than hiding it","You gave a hard, honest message when staying quiet would have been easier"]'::jsonb,
 '["What did you get wrong, and how did you handle telling people?","When did you say something uncomfortable because it was true?","How do people know your word is reliable?"]'::jsonb,
 '["no mistake ever admitted","candour claimed but only flattering details given","stayed quiet when honesty was needed"]'::jsonb,
 6, 'curated-2026', '2026-06-05')

ON CONFLICT (principle_id) DO UPDATE SET
    framework=EXCLUDED.framework, name=EXCLUDED.name,
    interpretation=EXCLUDED.interpretation, signal_keywords=EXCLUDED.signal_keywords,
    story_shapes=EXCLUDED.story_shapes, probing_patterns=EXCLUDED.probing_patterns,
    failure_modes=EXCLUDED.failure_modes, display_order=EXCLUDED.display_order,
    source=EXCLUDED.source, as_of=EXCLUDED.as_of;

COMMIT;
