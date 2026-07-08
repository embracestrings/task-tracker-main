// api/seed.js — ONE-TIME USE: re-seeds goals, ruleItems, and prompts after data loss.
// DELETE THIS FILE after confirming the seed worked.
import { kv } from "@vercel/kv";

const STATE_KEY = "tracker_state";

const GOALS = {
  personal: [
    { id: 'g_p1', text: "To grow my relationship with Akemi, and make progress towards deciding if she is the person I want to marry" },
    { id: 'g_p2', text: "To strengthen my relationships with family and friends" },
    { id: 'g_p3', text: "To find a path after college that excites me and allows me to keep up goals 1 and 2" },
    { id: 'g_p4', text: "To spend time enjoying myself" },
    { id: 'g_p5', text: "To grow my relationship with God" },
  ],
  professional: [
    { id: 'g_r1', text: "To improve at viola and feel out whether I pursue professional orchestra" },
    { id: 'g_r2', text: "To improve my time management" },
    { id: 'g_r3', text: "To learn and grow as a leader, entrepreneur, and person" },
    { id: 'g_r4', text: "To hold a Christmas Vespers in Boerne" },
  ],
};

const RULE_ITEMS = [
  // Abiding (8)
  { id: 'rl_a1', text: "I will read / listen to the Bible or Christian thought every day", cadence: 'daily',   category: 'Abiding' },
  { id: 'rl_a2', text: "I will spend at least 5 minutes of prayer and solitude at the beginning and end of every day", cadence: 'daily', category: 'Abiding' },
  { id: 'rl_a3', text: "I will remember people to pray for throughout the day", cadence: 'daily',   category: 'Abiding' },
  { id: 'rl_a4', text: "I will have a Sabbath every week",                         cadence: 'weekly',  category: 'Abiding' },
  { id: 'rl_a5', text: "I will go to church every Sunday when I am not travelling", cadence: 'weekly',  category: 'Abiding' },
  { id: 'rl_a6', text: "I will go to confession once a month",                      cadence: 'monthly', category: 'Abiding' },
  { id: 'rl_a7', text: "I will go to adoration once a month",                       cadence: 'monthly', category: 'Abiding' },
  { id: 'rl_a8', text: "I will do one session of fasting",                          cadence: 'annually',category: 'Abiding' },
  // Mind (3)
  { id: 'rl_m1', text: "I will read some part of a book every day",                cadence: 'daily',   category: 'Mind' },
  { id: 'rl_m2', text: "I will spend my Sabbath with a quiet mind, not concerned about work, etc.", cadence: 'weekly', category: 'Mind' },
  { id: 'rl_m3', text: "When travelling, I will let my mind rest and enjoy",        cadence: 'monthly', category: 'Mind' },
  // Body (4)
  { id: 'rl_b1', text: "I will workout Monday-Friday in the morning",               cadence: 'daily',   category: 'Body' },
  { id: 'rl_b2', text: "I will eat clean the majority of my meals",                 cadence: 'daily',   category: 'Body' },
  { id: 'rl_b3', text: "I will spend one day a week doing physical activities I enjoy", cadence: 'weekly', category: 'Body' },
  { id: 'rl_b4', text: "I will go camping, kayaking, or outdoors at least once a month", cadence: 'monthly', category: 'Body' },
  // Relationships (6)
  { id: 'rl_r1', text: "I will not be on my phone at meals with others",            cadence: 'daily',   category: 'Relationships' },
  { id: 'rl_r2', text: "I will be fully present at meals and on phone calls with Akemi", cadence: 'daily', category: 'Relationships' },
  { id: 'rl_r3', text: "I will spend at least one meal weekly with others",         cadence: 'weekly',  category: 'Relationships' },
  { id: 'rl_r4', text: "I will take Akemi on a date once a week when in town, or have a special night on call", cadence: 'weekly', category: 'Relationships' },
  { id: 'rl_r5', text: "I will reach out to friends I am not near at least once a month, preferably by call", cadence: 'monthly', category: 'Relationships' },
  { id: 'rl_r6', text: "I will invite people over at least once a month to enjoy time together", cadence: 'monthly', category: 'Relationships' },
  // Hospitality (1)
  { id: 'rl_h1', text: "I will volunteer at least once a month",                    cadence: 'monthly', category: 'Hospitality' },
  // Viola (4)
  { id: 'rl_v1', text: "I will practice viola every day except Sunday, no matter the amount of time. This can include playing, listening, or talking about music.", cadence: 'daily', category: 'Viola' },
  { id: 'rl_v2', text: "I will keep a practice journal and write entries after every practice session", cadence: 'daily', category: 'Viola' },
  { id: 'rl_v3', text: "I will make a plan for my practice that week",              cadence: 'weekly',    category: 'Viola' },
  { id: 'rl_v4', text: "I will hold at least 4 recitals each year",                cadence: 'quarterly', category: 'Viola' },
  // Time Management (4)
  { id: 'rl_t1', text: "I will do a 10 minute, daily review of my time",           cadence: 'daily',   category: 'Time Management' },
  { id: 'rl_t2', text: "I will do a weekly, 30 minute review of my time spent the last week and how to spend it the next week", cadence: 'weekly', category: 'Time Management' },
  { id: 'rl_t3', text: "I will do a monthly review of my time",                    cadence: 'monthly', category: 'Time Management' },
  { id: 'rl_t4', text: "I will do an annual review of my time",                    cadence: 'annually',category: 'Time Management' },
];

const PROMPTS = [
  { id: 'p1',  text: "What did you learn today about whether your relationship with Akemi is moving in the right direction?", goalId: 'g_p1' },
  { id: 'p2',  text: "Who did you deepen a relationship with today — and who did you neglect?",                                goalId: 'g_p2' },
  { id: 'p3',  text: "Did your energy today match your effort, or were they mismatched? Why?",                                goalId: null },
  { id: 'p4',  text: "Did you feel rushed today? What caused it?",                                                            goalId: 'g_r2' },
  { id: 'p5',  text: "What is one thing you did today that moved you closer to a life you're excited about?",                 goalId: 'g_p3' },
  { id: 'p6',  text: "Did you make time to enjoy something today — not for productivity, just for yourself?",                 goalId: 'g_p4' },
  { id: 'p7',  text: "How did you experience God today — in prayer, in people, or in a moment you almost missed?",            goalId: 'g_p5' },
  { id: 'p8',  text: "Did you pick up your viola today? If not, what got in the way?",                                       goalId: 'g_r1' },
  { id: 'p9',  text: "What is one leadership or entrepreneurial decision you made today — and would you make it the same way tomorrow?", goalId: 'g_r3' },
  { id: 'p10', text: "What would it look like if Christmas Vespers happened exactly as you hope? Did today move you any closer?", goalId: 'g_r4' },
  { id: 'p11', text: "Where did your Rule of Life feel like a burden today, and where did it feel like freedom?",             goalId: null },
  { id: 'p12', text: "If you could redo one moment from today, what would it be and why?",                                   goalId: null },
  { id: 'p13', text: "What was the quality of your attention today — were you present, or somewhere else?",                  goalId: null },
];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const current = await kv.get(STATE_KEY);
    if (!current) return res.status(404).json({ error: "No state found in KV — nothing to seed into" });

    // Snapshot before mutating
    await kv.set("tracker_state_pre_seed", current);

    const seeded = {
      ...current,
      goals:       GOALS,
      ruleItems:   RULE_ITEMS,
      ruleChecks:  current.ruleChecks?.length ? current.ruleChecks : [],
      reflections: current.reflections?.length ? current.reflections : [],
      prompts:     PROMPTS,
    };

    await kv.set(STATE_KEY, seeded);

    return res.status(200).json({
      ok: true,
      counts: {
        goalsPersonal:      GOALS.personal.length,
        goalsProfessional:  GOALS.professional.length,
        ruleItems:          RULE_ITEMS.length,
        prompts:            PROMPTS.length,
      },
    });
  } catch (err) {
    console.error("Seed error:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
