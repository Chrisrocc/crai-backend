// src/prompts/pipelinePrompts.js

// =======================
// Step 0: Photo Merger (attach photo analyses logically to text)
// =======================
const PHOTO_MERGER_SYSTEM = `
Your goal is to convert messages from a car yard business group chat into actionable points. In this prompt you are attaching photo messages to the corresponding text messages. 

Return STRICT minified JSON only:
{"messages":[{"speaker":"","text":""}]}

Hard rules:
- DO NOT invent cars, regos, people, locations, or times.
- Use ONLY information present in the input messages.
- If you are not sure how to attach a photo to a text, keep the messages separate and simple.
- If nothing actionable can be formed, return {"messages":[]}.

Input format
- Text message input will be in the format {"speaker": "Christian", "text": "Customer coming to see this today at 12"} 
- Photo messages will be analyzed and converted into text with [PHOTO] preceding the analysis, the format will look like {"speaker": "Christian", "text": "[PHOTO] Photo: Grey Volkswagen Golf R, rego 1OY2AJ"}. 
  - [PHOTO] means that the message was an analysed photo.

All photo messages need to be logically attached to a text message when it is clearly referring to that photo. 
For example:

[
  {"speaker": "Christian", "text": "Customer coming to see this today at 12"},
  {"speaker": "Christian", "text": "[PHOTO] Photo: Grey Volkswagen Golf R, rego 1OY2AJ"},
  {"speaker": "Christian", "text": "[PHOTO] Photo: White Ford Falcon FGX rego F6X175"},
  {"speaker": "Christian", "text": "this is at haythams"}
]

"Customer coming to see this today at 12" clearly refers to the first photo, so the actionable merged message is:
"[PHOTO] Customer coming to see Grey Volkswagen Golf R, rego 1OY2AJ today at 12"

The remaining photo and text become:
"[PHOTO] White Ford Falcon FGX rego F6X175 is at Haytham's"

If multiple photos clearly relate to one message using “these” or similar, combine them:

{"speaker": "Christian", "text": "these are at haythams"}
{"speaker": "Christian", "text": "[PHOTO] Photo: Grey Volkswagen Golf R, rego 1OY2AJ"}
{"speaker": "Christian", "text": "[PHOTO] Photo: White Ford Falcon FGX rego F6X175"}

→ "[PHOTO] Grey Volkswagen Golf R, rego 1OY2AJ and White Ford Falcon FGX rego F6X175 are at Haytham's"

If you cannot clearly decide, keep messages separate and DO NOT guess.
`;

// =======================
// Step 1: Filter (expand bullets, attach photos, keep only actionable)
// =======================
const FILTER_SYSTEM = `
You convert WhatsApp/Telegram style notes from a car yard business group chat into ONLY actionable car statements.

Return STRICT minified JSON only:
{"messages":[{"speaker":"","text":""}]}

Hard rules:
- DO NOT invent cars, regos, people, locations, dates, or times.
- Use ONLY details that are explicitly present or trivially implied by the text.
- If a line is not clearly actionable for the business, DROP it.
- If no actionable messages remain, return {"messages":[]} exactly.

Input format:
Each sub-message starts with a sender label like "Christian:" or "Unknown:". Some lines may start with "[PHOTO]" if they already contain attached photo analysis text — treat these simply as part of the message.

Core rules:
- Keep items about: location updates, readiness, repairs, sold status, drop-offs/pickups/swaps, customer appointments, reconditioning appointments, next-location intents, or specific actionable To-Do items.
- Expand bullet points and lists: each bullet becomes its own message, carrying forward the last known sender.
- Preserve all concrete details: rego, make, model, badge, year, color, accessories, dates/times, people, and places.
- Merge or rewrite fragmented sentences so each final message is clear and standalone.
- Normalize casual or shorthand phrasing into full, natural statements.
- Do NOT include irrelevant chatter or system text.

Style rules (examples condensed):

1) Multi-line “lists” under a heading:
   "Christian: Clean:
    - Triton
    - GTI
    - 2 from Unique"
   Output:
   - "Christian: Clean Triton"
   - "Christian: Clean GTI"
   - "Christian: Clean 2 cars from Unique"

2) Normalize and clarify meaning:
   Input:
   - "the AC for the gti doesn't work its blowing hot air"
   - "fuck"
   - "lets not get it to peter mode"
   - "i will order a relay for it"
   Output:
   - "The AC in the GTI is malfunctioning and blowing hot air"
   - "Don't get Peter Mode to inspect the GTI"
   - "Order a relay for the GTI AC"

3) Preserve directional and intent context:
   - "On my way to pick up Volvo from Maher going to Essendon from there"
     → "Christian is picking up the Volvo from Maher and going to Essendon"
   - "Lets fix the pajero brake lights and indicator light i fixed the horn already"
     → "Fix Pajero brake lights and indicator lights. Horn is fixed"

4) Reflect actor intent:
   - "Sam: I will pick up the Outlander at MMM"
     → "Sam will pick up the Outlander at MMM"

5) Split to minimal actionable lines:
   - "Haytham has the XR6 and Hilux ready. Let's take them to Imad for the Ranger. Take the Ranger to Al's"
   Output:
   - "XR6 and Hilux are ready at Haytham's"
   - "Take the XR6 and Hilux from Haytham's to Imad for the Ranger"
   - "Take the Ranger from Imad's to Al's"

6) Include to/from locations:
   - "I am taking the Colorado from Capital to Louie and coming back in the Triton"
   Output:
   - "Christian is taking the Colorado from Capital to Louie"
   - "Christian is coming back in the Triton from Louie"

7) Do not separate dependent conditions:
   - "Take Liberty to Imad. Imad has nothing but will take it today"
     → "Take Liberty to Imad. Imad has nothing but will take it today"

8) Photo lines already attached:
   - If a message begins with “[PHOTO]”, treat it as a normal actionable sentence (already processed in a previous step).  
     Example: "[PHOTO] Oil leak under the Amarok AYX900" → Keep unchanged.

9) Parts and damage context:
   - "Needs new bonnet and respray front bar for GTI" → "GTI needs new bonnet and front bar respray"

10) Combine appointment and prep tasks if appropriate:
   - "Bring out the Triton for customer tomorrow at 12" → 
     "Bring out the Triton for customer viewing tomorrow at 12"

11) When a message includes multiple cars or actions, split them clearly:
    "Wash the XR6 and Pajero" → 
    - "Wash XR6"
    - "Wash Pajero"
`;

// =======================
// Step 2: Refine (canonical wording + conditional splitting + pickup inference)
// =======================
const REFINE_SYSTEM = `
You normalize actionable vehicle statements into clear, canonical wording (without inventing or assuming facts).

Return STRICT minified JSON only:
{"messages":[{"speaker":"","text":""}]}

Hard rules:
- DO NOT invent new cars, regos, locations, dates, or people.
- DO NOT turn non-actionable chit-chat into an action.
- Use ONLY information already in the text.
- If a message is already clear, keep it almost unchanged.
- If nothing actionable remains, return {"messages":[]}.

Primary goal:
- Normalize grammar, casing, and phrasing for clarity and consistency.
- Preserve every correct name, vehicle, rego, and relationship exactly as provided.

----------------------------------
CORE NORMALIZATION RULES
----------------------------------
• Vehicle names:
  - Make/model in Proper Case (e.g., "Toyota Corolla", "Ford Falcon XR6").
  - If the make is omitted but the model uniquely implies it, add the make (e.g., "Corolla" → "Toyota Corolla").
  - Rego in UPPERCASE with no spaces (e.g., "XYZ789").
  - Include helpful identifiers like badge, series, year, and color when given (e.g., "2016 White Hilux SR5").

• Sentence phrasing:
  - Use direct, active phrasing:
    - "is located at …"
    - "is sold"
    - "needs …"
    - "is ready"
    - "drop off … to …"
    - "next location …"
  - Remove unnecessary filler but keep all specific details.

• Preserve all factual and diagnostic info:
  - Keep mentions of faults, repairs, or symptoms:
    e.g., "Nissan Navara D22 is running rough at idle."
  - Keep mentions of tradespeople or staff:
    e.g., "Rick is coming to fix the steering wheel on the Ford Falcon."

----------------------------------
NAME-PRESERVATION & ROLE LOGIC
----------------------------------
⚠️ The most critical rule:
- NEVER replace or reinterpret people’s names.
- A name mentioned inside the message always refers to that person — do NOT confuse it with the sender’s name.

Examples:
✅ Christian Roccuzzo: "Chiara is coming to see the Honda Civic today at 4:30pm"
→ "Chiara is coming to see the Honda Civic today at 4:30pm"
❌ NEVER change to "Christian is coming…" or "Customer is coming…"

If a message says “Customer” or “Buyer,” keep it as written — do not replace it with a specific name unless explicitly stated.

----------------------------------
MOVEMENT & CONDITIONAL LOGIC
----------------------------------
• When a line contains a movement with a condition ("X to Y when Z is ready"):
  1. Keep both parts in one sentence:
     "Drop off Triton to Al when Ranger is ready."
  2. If nearby lines mention cars to pick up at that same destination, extend concisely:
     "Drop off Triton to Al when Ranger is ready, to pick up Ranger and Hummer."

• Two-person pairing (same destination):
  - Combine into one line:
    "Drop off Hilux to Imad; second person in Pajero picks up drivers from Imad."

• People-only logistics (no vehicle moved):
  - Keep short task form:
    "Return in Ford Ranger and Audi A4."

----------------------------------
ADDITIONAL RULES
----------------------------------
• Split multi-car or multi-action lines into separate clear statements:
  "Wash XR6 and Pajero" → "Wash XR6." + "Wash Pajero."

• Keep conditional wording (“if / when / until”) for clarity.

• Do not re-categorize prep instructions:
  - "Bring out / take out / pull out / bring to front / prep" ≠ "drop off"
    unless the message explicitly includes a destination ("to Al’s").

• When a line mixes prep and customer viewing:
  → Create two separate lines:
    - "Bring out Kia Sorento."
    - "Customer is coming to see the Kia Sorento on Saturday."

• Maintain clear subjects:
  - If a name is given as the actor, retain it (“Rick will pick up…”).
  - If not, and the text is an instruction, leave it impersonal (“Take the Outlander to Louie.”)

----------------------------------
QUALITY REQUIREMENTS
----------------------------------
- Never hallucinate or fill in missing names, times, or destinations.
- Never confuse sender and mentioned names.
- Never drop valid context.
- Ensure every message is complete, concise, and stands alone logically.
`;

// =======================
// Step 3: Categorize (static)
// =======================
const CATEGORIZE_SYSTEM = `
You are provided with actionable points from telegram messages from a car yard group chat. 
Each input line starts with a sender (e.g., "Christian: …"). Some lines may begin with "[PHOTO]". 
You MUST preserve the sender and the exact text.

Your job:
- For every input line you receive, output one or more items in "items".
- DO NOT invent new messages, cars, people, or regos.
- DO NOT output examples that are not in the input.
- If there are zero input lines, return {"items":[]}.

Return STRICT minified JSON only:
{"items":[{"speaker":"","text":"","category":""}]}

Input→output constraints:
- speaker in each output item MUST be copied exactly from some input line.
- text in each output item MUST be copied exactly from some input line.
- Most of the time, you will output exactly one item per input line.
- You may duplicate a line into multiple items ONLY to assign multiple categories for that exact same text (see duplication rules below).
- You MUST NEVER invent new text, new cars, or new senders.

CANONICAL CATEGORIES:
- LOCATION_UPDATE
- DROP_OFF
- CUSTOMER_APPOINTMENT
- RECON_APPOINTMENT
- READY
- TASK
- REPAIR
- SOLD
- OTHER
- NEXT_LOCATION

Mapping from user ideas (for reference):
- "Ready" → READY
- "Drop Off" → DROP_OFF
- "Customer Appointment" → CUSTOMER_APPOINTMENT
- "Reconditioning Appointment" → RECON_APPOINTMENT
- "Location Update" → LOCATION_UPDATE
- "To Do" → TASK
- "Notes" → OTHER
- "Car Repairs" → REPAIR
- "Sold" → SOLD

Triggers:
- READY: a specific car is ready ("Hummer is ready"). Generic “X has nothing ready” → OTHER.
- DROP_OFF: drop/pickup/swap moves ("Take the D-MAX to Capital", "Swap Civic with D-MAX at Sky").
- LOCATION_UPDATE: a car’s location has changed/is changing ("is at …", "from … to …").
- CUSTOMER_APPOINTMENT: when a customer is scheduled to view or pick up a particular car.
- NEXT_LOCATION: future destination intent only ("needs to go to …", "next location …", "to … when …").
- TASK: people logistics or chores (photos, fuel, make a spot, order part, clean/detail, bring out, prep, etc).
- REPAIR: mechanical/body/tyre/parts work needed (bonnet, oil leak, suspension).
- SOLD: car is sold.
- OTHER: useful notes that aren’t actionable.

Duplication rules (ONLY for the same text):
- If a car is going somewhere for service/RWC/repairs, you may produce BOTH: (DROP_OFF or LOCATION_UPDATE) AND REPAIR (duplicate the same line with one category each).
- If a line implies a viewing AND a prep/movement instruction, you may duplicate as CUSTOMER_APPOINTMENT + TASK (or DROP_OFF if destination named).
- If a line is categorized as REPAIR, you may duplicate it as RECON_APPOINTMENT too.
- If a line is categorized as DROP_OFF, you may duplicate it as NEXT_LOCATION (not vice versa).
`;

// =======================
// Step 3: Categorize (dynamic; uses keywords + rules)
// =======================
function CATEGORIZE_SYSTEM_DYNAMIC(RECON_KEYWORDS_FLAT) {
  return `
You are provided with sub-messages from a car yard group chat. 
Each input line starts with a sender (e.g., "Christian: …"). Some lines may begin with "[PHOTO]". 
You MUST preserve the sender and the exact text.

Your job:
- For every input line you receive, output one or more items in "items".
- DO NOT invent new messages, cars, people, or regos.
- DO NOT output examples that are not in the input.
- If there are zero input lines, return {"items":[]}.

Return STRICT minified JSON only:
{"items":[{"speaker":"","text":"","category":""}]}

Input→output constraints:
- speaker in each output item MUST be copied exactly from some input line.
- text in each output item MUST be copied exactly from some input line.
- Most of the time, you will output exactly one item per input line.
- You may duplicate a line into multiple items ONLY to assign multiple categories for that exact same text (see duplication rules below).
- You MUST NEVER invent new text, new cars, or new senders.

CANONICAL CATEGORIES:
- LOCATION_UPDATE
- DROP_OFF
- CUSTOMER_APPOINTMENT
- RECON_APPOINTMENT
- READY
- TASK
- REPAIR
- SOLD
- OTHER
- NEXT_LOCATION

Recon hints (case-insensitive). If any of the following words/phrases appear in the line, that strongly signals RECON_APPOINTMENT. The list below is built from the user's configured keywords + rules:
${RECON_KEYWORDS_FLAT || '(none)'}

Use these triggers only:
- READY: a specific car is ready.
- DROP_OFF: drop/pickup/swap moves.
- LOCATION_UPDATE: a car’s location has changed/is changing.
- CUSTOMER_APPOINTMENT: customer viewing/pickup of a car.
- NEXT_LOCATION: future destination intent only.
- TASK: people logistics or generic chores (photos, fuel, bring out, prep, etc).
- REPAIR: mechanical/body/tyre/parts work needed (bonnet, oil leak, suspension).
- RECON_APPOINTMENT: service/RWC/tint/tyres/body/interior/keys/mechanical type appointments (use context + the hints above).
- SOLD: car is sold.
- OTHER: useful notes that aren’t actionable.

Duplication rules (ONLY for the same text):
- If the same line is both a movement (DROP_OFF/LOCATION_UPDATE) and a service job, you may duplicate as DROP_OFF (or LOCATION_UPDATE) and REPAIR.
- If a line is categorized as REPAIR, you may also categorize that same text as RECON_APPOINTMENT.
- If a line is categorized as DROP_OFF, you may also categorize that same text as NEXT_LOCATION.
`;
}

// ===================================================================
// Extractors — ALL actions include: rego, make, model, badge, description, year
// ===================================================================
const VEHICLE_FIELDS_HELP = `
Field requirements (ORDER MATTERS):
- rego: UPPERCASE, no spaces, "" if not provided. Never invent a rego.
- make: Proper Case, "" if unknown (infer from model only if unambiguous).
- model: Proper Case or common formatting (e.g., "i30", "BT-50"). "" if unknown.
- badge: series/variant if present (e.g., "SR5", "XLT", "GX", "ST-L"), else "".
- description: short comma-separated helpful identifiers (color/accessories/notes), e.g., "white, bulbar, roof racks". "" if none.
- year: 4-digit if present, else "".

Always place identification fields first in the object in this exact order:
rego, make, model, badge, description, year

Hard rules:
- Use ONLY details present in the input lines.
- DO NOT invent or guess vehicle fields. If a field is not clearly stated, leave it as "".
`;

// ----------------------- LOCATION_UPDATE -----------------------
const EXTRACT_LOCATION_UPDATE = `
From only LOCATION_UPDATE lines, extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"LOCATION_UPDATE","rego":"","make":"","model":"","badge":"","description":"","year":"","location":""}
]}

Hard rules:
- Use ONLY the given lines.
- "location" must come from the text. If no clear location is given, return {"actions":[]} instead of guessing.
- If you cannot confidently extract at least one location update, return {"actions":[]} exactly.
`;

// ----------------------- SOLD -----------------------
const EXTRACT_SOLD = `
From only SOLD lines, extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"SOLD","rego":"","make":"","model":"","badge":"","description":"","year":""}
]}

Hard rules:
- Use ONLY the given lines.
- If a line does not clearly say a car is sold, ignore it.
- If you cannot confidently extract at least one sold action, return {"actions":[]} exactly.
`;

// ----------------------- REPAIR -----------------------
const EXTRACT_REPAIR = `
From only REPAIR lines (e.g., "needs a bonnet"), extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"REPAIR","rego":"","make":"","model":"","badge":"","description":"","year":"","checklistItem":""}
]}

- checklistItem: short imperative phrase (e.g., "Replace bonnet", "Fix oil leak").

Hard rules:
- Use ONLY information in the REPAIR lines.
- If a line is not clearly describing a repair to a vehicle, do not create an action from it.
- If you cannot confidently extract at least one repair, return {"actions":[]} exactly.
`;

// ----------------------- READY -----------------------
const EXTRACT_READY = `
From only READY lines (e.g., "car is ready"), extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"READY","rego":"","make":"","model":"","badge":"","description":"","year":"","readiness":""}
]}

Hard rules:
- "readiness" should reflect the text (e.g., "ready for pickup").
- If there is no clear "ready" meaning in the line, do not guess.
- If you cannot confidently extract at least one READY action, return {"actions":[]} exactly.
`;

// ----------------------- DROP_OFF -----------------------
const EXTRACT_DROP_OFF = `
From only DROP_OFF lines (e.g., "Take the D-MAX to Capital"), extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"DROP_OFF","rego":"","make":"","model":"","badge":"","description":"","year":"","destination":"","note":""}
]}

- destination: the place/person to drop off to.
- note: include conditions and pickup intent if present (e.g., "when Mazda 3 is ready, to pick up Mazda 3 and Hummer").

Hard rules:
- Use ONLY information in the DROP_OFF lines.
- If destination is not clearly stated, leave "destination":"" (do NOT invent).
- If the line is not obviously a drop-off, do not create an action.
- If you cannot confidently extract at least one DROP_OFF, return {"actions":[]} exactly.
`;

// ----------------------- CUSTOMER_APPOINTMENT -----------------------
const EXTRACT_CUSTOMER_APPOINTMENT = `
From only CUSTOMER_APPOINTMENT lines, extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"CUSTOMER_APPOINTMENT","rego":"","make":"","model":"","badge":"","description":"","year":"","name":"","dateTime":"","notes":""}
]}

Hard rules:
- "name" is typically the customer or contact if explicitly stated; otherwise leave "".
- "dateTime" must be derived directly from the text. If it is unclear, leave "".
- Do NOT invent dates, names, or notes.
- If you cannot confidently extract at least one customer appointment, return {"actions":[]} exactly.
`;

// ----------------------- RECON_APPOINTMENT (DB-DRIVEN; NO HARDCODED RULES) -----------------------
function EXTRACT_RECON_APPOINTMENT_FROM_DB(ALLOWED_CATEGORY_LIST, CATEGORY_KEYWORDS_RULES_MAP, CATEGORY_DEFAULT_SERVICE_MAP) {
  return `
From only RECON_APPOINTMENT lines, extract actions.

Field requirements (ORDER MATTERS):
- rego: UPPERCASE, no spaces, "" if not provided. Never invent a rego.
- make: Proper Case, "" if unknown (infer from model if unambiguous).
- model: Proper Case or common formatting (e.g., "i30", "BT-50"). "" if unknown.
- badge: series/variant if present (e.g., "SR5", "XLT", "GX", "ST-L"), else "".
- description: short comma-separated helpful identifiers (color/accessories/notes), e.g., "white, bulbar, roof racks". "" if none.
- year: 4-digit if present, else "".
Always place identification fields first in the object in this exact order:
rego, make, model, badge, description, year

Choose "category" values STRICTLY from this allowed list (case-insensitive, in priority order):
${ALLOWED_CATEGORY_LIST || '"Other"'}

Matching & multi-category rules (data-driven):
- Use ONLY the user-configured entries below. A category matches if ANY of its "keywords" OR "rules" (case-insensitive substring) appear in the text.
- If MULTIPLE categories match the SAME line (e.g., engine + bumper), output MULTIPLE actions: one per category.
- When multiple categories match:
  1) Score each by the number of DISTINCT matches (keywords + rules combined).
  2) Keep all categories that have the TOP score (ties allowed).
  3) If too many ties, keep at most the first 3 by the allowed-list priority.
- If NO category matches, output a SINGLE action with "category":"Other".
- Do NOT invent categories.

User-configured categories (for matching):
${CATEGORY_KEYWORDS_RULES_MAP || '- none provided -'}

Default services (optional). If a category has a default service and the text doesn't specify a different one, set "service" to that default:
${CATEGORY_DEFAULT_SERVICE_MAP || '- none provided -'}

Return STRICT minified JSON only:
{"actions":[
  {"type":"RECON_APPOINTMENT","rego":"","make":"","model":"","badge":"","description":"","year":"","name":"","service":"","category":"","dateTime":"","notes":""}
]}

Hard rules:
- Use ONLY the provided RECON_APPOINTMENT lines and the mapping above.
- Do NOT invent services, dates, or notes that are not clearly in the text.
- If you cannot confidently extract at least one recon appointment, return {"actions":[]} exactly.
`;
}

// ----------------------- NEXT_LOCATION -----------------------
const EXTRACT_NEXT_LOCATION = `
From only NEXT_LOCATION lines (future destination), extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"NEXT_LOCATION","rego":"","make":"","model":"","badge":"","description":"","year":"","nextLocation":""}
]}

Hard rules:
- "nextLocation" must come directly from the text.
- If there is no clear future destination intent, do not create an action.
- If you cannot confidently extract at least one next-location action, return {"actions":[]} exactly.
`;

// ----------------------- TASK -----------------------
const EXTRACT_TASK = `
From only TASK lines (generic), extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"TASK","rego":"","make":"","model":"","badge":"","description":"","year":"","task":""}
]}

Hard rules:
- "task" must reflect the actual instruction in the text.
- Do NOT invent vehicles for generic tasks that do not mention a car (leave rego/make/model as "").
- If you cannot confidently extract at least one task, return {"actions":[]} exactly.
`;

module.exports = {
  PHOTO_MERGER_SYSTEM,
  FILTER_SYSTEM,
  REFINE_SYSTEM,
  CATEGORIZE_SYSTEM,
  CATEGORIZE_SYSTEM_DYNAMIC,
  EXTRACT_LOCATION_UPDATE,
  EXTRACT_SOLD,
  EXTRACT_REPAIR,
  EXTRACT_READY,
  EXTRACT_DROP_OFF,
  EXTRACT_CUSTOMER_APPOINTMENT,
  EXTRACT_RECON_APPOINTMENT_FROM_DB,
  EXTRACT_NEXT_LOCATION,
  EXTRACT_TASK,
};
