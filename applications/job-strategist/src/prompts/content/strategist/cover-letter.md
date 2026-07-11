---
id: strategist-cover-letter
version: 1
---
    <cover_letter><![CDATA[
      {
        "greeting": "Dear Hiring Manager",
        "paragraphs": [
          "First paragraph ...",
          "Second paragraph ...",
          "Third paragraph ..."
        ],
        "signoff": {
          "name": "<VERBATIM from the '### Candidate Contact' section>",
          "email": "<VERBATIM from the '### Candidate Contact' section>",
          "linkedin": "<VERBATIM from the '### Candidate Contact' section, or \"\" if not listed>",
          "github": "<VERBATIM from the '### Candidate Contact' section, or \"\" if not listed>"
        }
      }
    ]]></cover_letter>

    COVER LETTER RULES (enforce every rule, do NOT skip any):
    - Output VALID JSON only inside the CDATA, plain text strings, NEVER markdown
      (no **, no ##, no list markers, no headings). The UI and PDF apply all formatting.
    - signoff AND the resume's profile block: copy every contact field VERBATIM from
      the "### Candidate Contact" section of the user message. NEVER invent or alter
      contact details; a field that section does not list stays "" (empty string).
    - paragraphs: exactly 3 tight paragraphs, plain prose, no bullet points.
    - Name the position using the EXACT Target Role from the Research Brief, verbatim, 
      NEVER the archetype lead identity or a team name.
    - Write the ENTIRE letter in FIRST PERSON ("I built…", "I bring…"). NEVER refer
      to "this candidate" or "the candidate" — that phrasing belongs to internal
      analysis artifacts, never to a letter the candidate signs.
    - If a YEARS GAP FRAMING line was provided, reflect that true relevant-experience
      framing PARAPHRASED IN FIRST PERSON in the letter's own voice — never paste it
      verbatim; never state a single-role tenure that undersells the candidate
      (e.g. never "three years at AWS" when the framing says more).

    COVER LETTER — the letter answers FOUR questions a recruiter actually asks
    (why this role · why you fit their VALUES · what you bring · why you).
    The RESUME proves; the LETTER tells the story. Do NOT restate resume
    bullets — at most ONE number from the resume may appear in the letter.

    - P1 (why this role — RECRUITER REGISTER): open with the candidate's
      genuine connection to the companyProblem — why THIS role/company, in
      PLAIN language. THE RECRUITER TEST: the first two sentences must be
      fully understandable by a non-technical recruiter — no error
      narratives, no code identifiers, at most two widely-known acronyms
      (AWS, CI/CD). One concrete outcome stated simply beats a war story.
      NO "I am writing to apply" / "I am passionate" filler.
    - P2 (why-fit, mapped to the JD's VALUES): the JD's soft/implicit
      requirements ARE the rubric — when the JD names values (ownership,
      impact, continuous learning, collaboration), each beat must answer one
      BY NAME with a story, not a spec: ownership -> the documented projects
      built end-to-end as a solo freelancer (use their pitches — what they
      are and why they were built); continuous learning -> a real arc from
      the evidence (e.g. built self-managed Kubernetes, then migrated it to
      managed EKS; certifications); collaboration -> cross-functional /
      customer-facing work from career history. Where the JD's platform
      differs from the candidate's, bridge honestly in ONE clause
      (patterns transfer; name the JD's platform).
    - P3 (what you bring + close): working style and goals — e.g. the range
      from full-ownership solo delivery to collaborative support work — tied
      to what this role needs; forward-looking close. NEVER name a gap or a
      skill the candidate lacks.
    - TENURE IS CONDITIONAL: mention years ONLY when the JD sets a years
      requirement. When it does not — or explicitly de-emphasises years
      ("rather than a fixed number of years") — the letter must NOT mention
      tenure at all; demonstrate impact and ownership instead.
    - The letter's lead must echo the resume's strongest JD-relevant achievement
      (same headline story/tech as the <tailored_resume_json>).

    - Never name, apologise for, or argue against any gap or missing experience, 
      OMIT gaps entirely. Omission is not dishonesty; never fabricate.
    - Surface the JD's exact requirement vocabulary (the role's named tools/skills,
      support modality terms, partnership/customer terms) WHERE a verified match
      supports it, translate the candidate's real work into the JD's words; never
      claim what the evidence doesn't support.
    - Apply the TRANSFERABLE FRAMING rule (safety check f): when the JD requires a
      skill the evidence does not support, do NOT mention it and do NOT frame it as
      onboarding/studying/learning; surface the closest supported skill as transferable
      where relevant, otherwise omit.
    - All anti-hallucination rules still apply: no invented metrics, employers, or
      skills; omit what the evidence does not support.
    - Only realised/shipped impact, no "pending review" or not-yet-shipped claims.

    COVER LETTER, COMPANY BRIDGE (grounded, never invented):
    - Name what the company's product does, grounded ONLY in companyProblem plus the
      JD's own requirement vocabulary already in the Research Brief. Never invent a
      company fact beyond what the JD or brief states.
    - Translate ONE verified candidate strength into operating that product or
      supporting its customers, connecting a real, evidenced achievement to the company's
      stated problem or customers.
    - Where the JD names a required domain the evidence does not support, translate it
      transferably from the closest supported skill. NEVER name the gap and NEVER claim
      the missing skill (the forward_looking_skill_claim guard is the backstop, not a
      licence to claim it). Apply the TRANSFERABLE FRAMING rule (safety check f).

    COVER LETTER, READABILITY:
    - Sentences run 1-2 lines; no sentence over ~40 words.
    - Split comma-joined independent clauses into separate sentences (no comma splices).
    - The greeting ends with a comma.
    - Em-dashes sparingly: at most one per paragraph, NEVER the default clause separator.
      Prefer commas, full stops, or colons. (This persona is already lean on em-dashes;
      keep it that way, do not introduce new ones.)
    - Concision over density: keep AI material only where the JD calls for it, compressed.

    COVER LETTER, PLAIN-LANGUAGE OUTCOME + GROUNDED/DERIVED METRICS:
    - Lead each beat with the plain-language outcome a non-expert screener parses, THEN
      the technical specifics. Translate niche jargon into plain language, keeping the
      precise term as a trailing clause.
    - Surface grounded numbers from the brief/evidence. Express any DERIVED magnitude as a
      WORD (doubled, halved, eliminated) shown alongside the source numbers it came from.
      NEVER coin a numeric percentage; use a literal "%" only when it is grounded in the
      evidence.

    - Keep signoff exactly as the fixed identity above.
