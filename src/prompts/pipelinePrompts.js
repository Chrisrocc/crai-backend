// src/prompts/pipelinePrompts.js

// =======================
// Step 0: Photo Merger (attach photo analyses logically to text)
// =======================
const PHOTO_MERGER_SYSTEM = `
Your goal is to convert messages from a car yard business group chat into actionable points. In this prompt you are attaching photo messages to the corresponding text messages. 

Return STRICT minified JSON only:
{"messages":[{"speaker":"","text":""}]}

Input format
- Text message input will be in the format {"speaker": "Christian", "text": "Customer coming to see this today at 12"} 
- Photo messages will be analyzed and converted into text with [PHOTO] preceding the analysis, the format will look like {"speaker": "Christian", "text": "[PHOTO] Photo: Grey Volkswagen Golf R, rego 1OY2AJ"}. 
    - So [PHOTO] means that the message was an analysed photo 

All photo messages need to be logically attached to a text message. 
For example 

[
  {"speaker": "Christian", "text": "Customer coming to see this today at 12"},
  {"speaker": "Christian", "text": "[PHOTO] Photo: Grey Volkswagen Golf R, rego 1OY2AJ"},
  {"speaker": "Christian", "text": "[PHOTO] Photo: White Ford Falcon FGX rego F6X175"},
  {"speaker": "Christian", "text": "this is at haythams"}
]


{"speaker": "Christian", "text": "Customer coming to see this today at 12"} in this message "this" would refer to the grey volkswagen [PHOTO] Photo: Grey Volkswagen Golf R, rego 1OY2AJ because in the group chat the user would say "customer coming to see this" + photo of the car. So from this the actionable point would be "Customer is coming to the Grey Volkswagen Golf R, rego 1OY2AJ today at 12" 

As there is now another photo message and a text message, and just logically then, the second actionable point would be "White Ford Falcon FGX rego F6X175 is at Haytham's"

However remember to always use logic as some cases two photos might belong to one message. Where multiple photos clearly relate to one message using “these, or a similar term” combine them logically into one message

{"speaker": "Christian", "text": "these are at haythams"}
{"speaker": "Christian", "text": "[PHOTO] Photo: Grey Volkswagen Golf R, rego 1OY2AJ"},
{"speaker": "Christian", "text": "[PHOTO] Photo: White Ford Falcon FGX rego F6X175"},

The actionable point would be 

Grey Volkswagen Golf R, rego 1OY2AJ and White Ford Falcon FGX rego F6X175 are at Haytham's 

Here are some examples of input and output 

[
  {
    "input": [
      {"speaker": "Christian", "text": "Customer coming to see this today at 12"},
      {"speaker": "Christian", "text": "[PHOTO] Photo analysis: Grey Volkswagen Golf R, rego 1OY2AJ"}
    ],
    "output": {
      "messages": [
        {"speaker": "Christian", "text": "[PHOTO] Customer coming to see Grey Volkswagen Golf R, rego 1OY2AJ today at 12"}
      ]
    }
  },

  {
    "input": [
      {"speaker": "Christian", "text": "[PHOTO] Photo analysis: oil leak on floor under engine bay"},
      {"speaker": "Christian", "text": "under the Amarok AYX900"}
    ],
    "output": {
      "messages": [
        {"speaker": "Christian", "text": "[PHOTO] Oil leak under the Amarok AYX900"}
      ]
    }
  },

  {
    "input": [
      {"speaker": "Christian", "text": "[PHOTO] Photo analysis: dashboard light visible but unclear"},
      {"speaker": "Christian", "text": "belongs to the Pajero"}
    ],
    "output": {
      "messages": [
        {"speaker": "Christian", "text": "[PHOTO] Unclear dashboard warning light on the Pajero"}
      ]
    }
  },

  {
    "input": [
      {"speaker": "Christian", "text": "[PHOTO] Photo analysis: set of alloy wheels"},
      {"speaker": "Christian", "text": "fit these to the Hilux"}
    ],
    "output": {
      "messages": [
        {"speaker": "Christian", "text": "[PHOTO] Set of alloy wheels to fit on the Hilux"}
      ]
    }
  }
]
`;

// =======================
// Step 1: Filter (expand bullets, attach photos, keep only actionable)
// =======================
const FILTER_SYSTEM = `
You convert WhatsApp/Telegram style notes from a car yard business group chat into ONLY actionable car statements.

Return STRICT minified JSON only:
{"messages":[{"speaker":"","text":""}]}

Input format:
Each sub-message starts with a sender label like "Christian:" or "Unknown:". Some lines may start with "[PHOTO]" if they already contain attached photo analysis text — treat these simply as part of the message.

Core rules:
- Keep items about: location updates, readiness, repairs, sold status, drop-offs/pickups/swaps, customer appointments, reconditioning appointments, next-location intents, or specific actionable To-Do items.
- Expand bullet points and lists: each bullet becomes its own message, carrying forward the last known sender.
- Preserve all concrete details: rego, make, model, badge, year, color, accessories, dates/times, people, and places.
- Merge or rewrite fragmented sentences so each final message is clear and standalone.
- Normalize casual or shorthand phrasing into full, natural statements.
- Do NOT include irrelevant chatter or system text.
- If no actionable messages remain, return {"messages":[]}.

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

If no actionable content remains, return {"messages":[]}.
`;

// =======================
// Step 2: Refine (canonical wording + conditional splitting + pickup inference)
// =======================
const REFINE_SYSTEM = `

You normalize actionable vehicle statements into clear, canonical wording (without inventing or assuming facts).

Return STRICT minified JSON only:
{"messages":[{"speaker":"","text":""}]}

Primary goal:
- Normalize grammar, casing, and phrasing for clarity and consistency.
- DO NOT infer new facts, people, locations, or intent that are not explicitly stated.
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
- **NEVER replace or reinterpret people’s names.**
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

If nothing actionable remains, return:
{"messages":[]}

`;

// =======================
// Step 3: Categorize (DB-driven hook for RECON via keywords)
// =======================
const CATEGORIZE_SYSTEM = `
You are provided with actionable points from telegram messages from a car yard group chat. Each line starts with a sender (e.g., "Christian: …"). Some lines may begin with "[PHOTO]". Preserve the sender and any "[PHOTO]".
Assign exactly one canonical category per output line. If a line legitimately belongs to two categories, DUPLICATE the line so each copy has one category.

Return STRICT minified JSON only:
{"items":[{"speaker":"","text":"","category":""}]}

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
- TASK: people logistics or chores (photos, fuel, make a spot, order part, clean/detail, **bring out / prep**, etc).
- REPAIR: mechanical/body/tyre/parts work needed (bonnet, oil leak, suspension).
- SOLD: car is sold.
- OTHER: useful notes that aren’t actionable.

Dual-category rules:
- If a car is going somewhere for service/RWC/repairs, produce BOTH: (DROP_OFF or LOCATION_UPDATE) AND REPAIR (duplicate the line with one category each).
- If a line implies a viewing AND a prep/movement instruction, DUPLICATE as CUSTOMER_APPOINTMENT + TASK (or DROP_OFF if destination named).
- If a line is categorized as REPAIR, duplicate it as RECON_APPOINTMENT too.
  Example:
  Christian: "Toyota Camry TGS655 needs taillights replaced."
  →
  REPAIR - Christian: "Toyota Camry TGS655 needs taillights replaced."
  RECON_APPOINTMENT - Christian: "Toyota Camry TGS655 needs taillights replaced."
- If a line is categorized as DROP_OFF, duplicate it as NEXT_LOCATION (not vice versa).
  Example:
  Christian: "Drop off Dmax to Capital."
  →
  DROP_OFF - Christian: "Drop off Dmax to Capital."
  NEXT_LOCATION - Christian: "Drop off Dmax to Capital."
`;

// Step 3: Categorize (dynamic; uses keywords + rules)
function CATEGORIZE_SYSTEM_DYNAMIC(RECON_KEYWORDS_FLAT) {
  return `
You are provided with sub-messages from a car yard group chat. Each line starts with a sender (e.g., "Christian: …"). Some lines may begin with "[PHOTO]". Preserve the sender and any "[PHOTO]".
Assign exactly one canonical category per output line. If a line legitimately belongs to two categories, DUPLICATE the line so each copy has one category.

Return STRICT minified JSON only:
{"items":[{"speaker":"","text":"","category":""}]}

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

Recon hints (case-insensitive). If any of the following words/phrases appear in the line, that strongly signals RECON_APPOINTMENT. This list is built from the user's configured **keywords + rules**:
${RECON_KEYWORDS_FLAT || '(none)'}

Use these triggers only:
- READY: a specific car is ready.
- DROP_OFF: drop/pickup/swap moves.
- LOCATION_UPDATE: a car’s location has changed/is changing.
- CUSTOMER_APPOINTMENT: customer viewing/pickup of a car.
- NEXT_LOCATION: future destination intent only.
- TASK: people logistics or generic chores (photos, fuel, bring out, prep, etc).
- REPAIR: mechanical/body/tyre/parts work needed (bonnet, oil leak, suspension).
- RECON_APPOINTMENT: service/RWC/tint/tyres/body/interior/keys/mechanical type appointments (context + the hints above).
- SOLD: car is sold.
- OTHER: useful notes that aren’t actionable.

Duplication:
- If the same line is both a movement (DROP_OFF/LOCATION_UPDATE) and a service job, duplicate as DROP_OFF (or LOCATION_UPDATE) and REPAIR.
`;
}

// ===================================================================
// Extractors — ALL actions include: rego, make, model, badge, description, year
// ===================================================================

const VEHICLE_FIELDS_HELP = `
Field requirements (ORDER MATTERS):
- rego: UPPERCASE, no spaces, "" if not provided.
- make: Proper Case, "" if unknown (infer from model if unambiguous).
- model: Proper Case or common formatting (e.g., "i30", "BT-50").
- badge: series/variant if present (e.g., "SR5", "XLT", "GX", "ST-L"), else "".
- description: short comma-separated helpful identifiers (color/accessories/notes), e.g., "white, bulbar, roof racks". "" if none.
- year: 4-digit if present, else "".

Always place identification fields first in the object in this exact order:
rego, make, model, badge, description, year
`;

// ----------------------- LOCATION_UPDATE -----------------------
const EXTRACT_LOCATION_UPDATE = `
From only LOCATION_UPDATE lines, extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"LOCATION_UPDATE","rego":"","make":"","model":"","badge":"","description":"","year":"","location":""}
]}
`;

// ----------------------- SOLD -----------------------
const EXTRACT_SOLD = `
From only SOLD lines, extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"SOLD","rego":"","make":"","model":"","badge":"","description":"","year":""}
]}
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
`;

// ----------------------- READY -----------------------
const EXTRACT_READY = `
From only READY lines (e.g., "car is ready"), extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"READY","rego":"","make":"","model":"","badge":"","description":"","year":"","readiness":""}
]}
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
`;

// ----------------------- CUSTOMER_APPOINTMENT -----------------------
const EXTRACT_CUSTOMER_APPOINTMENT = `
From only CUSTOMER_APPOINTMENT lines, extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"CUSTOMER_APPOINTMENT","rego":"","make":"","model":"","badge":"","description":"","year":"","name":"","dateTime":"","notes":""}
]}
`;

// ----------------------- RECON_APPOINTMENT (DB-DRIVEN; NO HARDCODED RULES) -----------------------
// RECON_APPOINTMENT extractor (DB-driven; uses keywords + rules)
function EXTRACT_RECON_APPOINTMENT_FROM_DB(ALLOWED_CATEGORY_LIST, CATEGORY_KEYWORDS_MAP) {
  return `
From only RECON_APPOINTMENT lines, extract actions.

Field requirements (ORDER MATTERS):
- rego: UPPERCASE, no spaces, "" if not provided.
- make: Proper Case, "" if unknown (infer from model if unambiguous).
- model: Proper Case or common formatting (e.g., "i30", "BT-50").
- badge: series/variant if present (e.g., "SR5", "XLT", "GX", "ST-L"), else "".
- description: short comma-separated helpful identifiers (color/accessories/notes), e.g., "white, bulbar, roof racks". "" if none.
- year: 4-digit if present, else "".
Always place identification fields first in the object in this exact order:
rego, make, model, badge, description, year

Choose the category STRICTLY from this allowed list (case-insensitive):
${ALLOWED_CATEGORY_LIST || '"Other"'}

Category assignment rules (data-driven):
- Use ONLY the user-configured **keywords/rules** below. A category matches if any of its keywords OR rules (case-insensitive substring match) appear in the text.
- If multiple categories match, pick the one with the most distinct keyword/rule hits; if still tied, pick the one that appears first in the allowed list above.
- If NO category matches, set category to "Other".
- Do NOT invent categories.

User-configured keywords/rules per category:
${CATEGORY_KEYWORDS_MAP || '- none provided -'}

Return STRICT minified JSON only:
{"actions":[
  {"type":"RECON_APPOINTMENT","rego":"","make":"","model":"","badge":"","description":"","year":"","name":"","service":"","category":"","dateTime":"","notes":""}
]}

- Strings only. Unknown → "".
- Keep keys in EXACT order as shown above.
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
`;

// ----------------------- TASK -----------------------
const EXTRACT_TASK = `
From only TASK lines (generic), extract actions.

${VEHICLE_FIELDS_HELP}

Return STRICT minified JSON only:
{"actions":[
  {"type":"TASK","rego":"","make":"","model":"","badge":"","description":"","year":"","task":""}
]}
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