// Release-stamped vocabulary for the Folsom chat assistant. Codes and labels
// only — never counts; counts come from the stats tool so the model cannot
// quote stale numbers. Regenerate when a new corpus release ships.

export const RELEASE = {
  release_id: "v0.2.0",
  released_date: "2026-08-10",
  coverage_end: "2026-07-08",
};

export const OUTCOMES = ["fair_use", "not_fair_use", "unresolved", "not_reached"];

export const DIRECTIONS = [
  "favors_fair_use", "disfavors_fair_use", "neutral", "mixed", "unclear",
  "not_analyzed",
];

export const COURT_LEVELS = ["supreme", "circuit", "district"];

export const CIRCUITS = [
  "ca1", "ca2", "ca3", "ca4", "ca5", "ca6", "ca7", "ca8", "ca9", "ca10",
  "ca11", "cadc", "cafc", "scotus", "fedcl",
];

export const PUBLICATION_STATUSES = ["published", "unpublished", "slip", "unknown"];

export const POSTURES = [
  "appellate_review", "bench_trial", "certiorari_review",
  "cross_motions_summary_judgment", "declaratory_judgment", "default_judgment",
  "fee_or_sanctions", "judgment_as_matter_of_law", "judgment_on_pleadings",
  "jury_trial", "motion_to_dismiss", "other", "partial_summary_judgment",
  "post_trial_motion", "preliminary_injunction", "remand",
  "report_and_recommendation", "summary_judgment",
  "temporary_restraining_order",
];

export const WORK_TYPES = [
  "photograph", "literary", "visual_art", "film_or_television", "video",
  "musical_composition", "software_or_source_code", "database_or_compilation",
  "sound_recording", "academic", "news", "graphic_design_or_logo",
  "test_or_assessment", "unpublished_correspondence_or_manuscript",
  "biographical", "architectural", "game", "website_or_social_post", "legal",
  "technical_standard", "api", "map", "choreography", "mixed", "other",
  "unknown",
];

export const USE_TYPES = [
  "reproduction_or_republication", "commentary", "advertising_or_promotion",
  "news_reporting", "quotation_or_excerpt", "criticism_or_review", "parody",
  "documentary_or_biographical", "artistic_appropriation",
  "teaching_or_classroom", "software_interoperability_or_reverse_engineering",
  "litigation_or_evidence", "linking_or_embedding", "merchandising",
  "search_or_indexing", "scholarship_or_research",
  "machine_learning_or_ai_training", "personal_use", "satire", "thumbnail",
  "time_or_space_shifting", "api_reimplementation", "archive_or_preservation",
  "generative_ai_output", "standards_incorporation", "data_mining_or_scraping",
  "library_lending", "accessibility", "mixed", "other", "unknown",
];

export const TECH_CONTEXTS = [
  "internet_or_website", "print", "photography", "film_or_video", "software",
  "broadcast", "social_media", "streaming", "search_engine",
  "artificial_intelligence", "mobile_platform", "digital_library",
  "cloud_service", "none", "other", "unknown",
];

export const COMPONENT_CODES = {
  1: ["f1_purpose_character", "f1_commerciality", "f1_transformativeness",
      "f1_justification", "f1_statutory_preamble", "f1_purpose_similarity",
      "f1_new_expression_meaning_message", "f1_public_benefit",
      "f1_good_bad_faith", "f1_other"],
  2: ["f2_factual_creative", "f2_published_status", "f2_factor_discounted",
      "f2_availability", "f2_functional_character", "f2_other"],
  3: ["f3_quantitative_amount", "f3_entire_work", "f3_necessity_reasonableness",
      "f3_qualitative_heart", "f3_targeting", "f3_other"],
  4: ["f4_market_definition", "f4_potential_harm", "f4_substitution",
      "f4_burden_or_presumption", "f4_actual_harm", "f4_licensing_market",
      "f4_traditional_market", "f4_reasonable_market", "f4_derivative_market",
      "f4_public_benefit_balance", "f4_market_circularity", "f4_other"],
};

// One-paragraph codebook injected into the system prompt. Kept terse: the
// tool parameter enums carry the full value lists.
export const CODEBOOK_NOTE = `Units of analysis: an OPINION (OP######) is one judicial opinion; a WORK/USE UNIT is one copyrighted-work-versus-challenged-use pairing inside an opinion (an opinion can have many); a HOLDING is the fair use outcome for one unit; a FACTOR ASSESSMENT is the court's coded lean on one statutory factor for one unit. Outcomes: fair_use, not_fair_use, unresolved (analyzed but not decided, e.g. summary judgment denied), not_reached. Factor directions: favors_fair_use, disfavors_fair_use, neutral, mixed, unclear, not_analyzed. Factors: 1 purpose/character, 2 nature of the work, 3 amount/substantiality, 4 market effect. Classifications (work_type, use_type, technology_context) are opinion-level and non-exclusive: one opinion can carry several values, so their counts can exceed the opinion total. Postures are also non-exclusive.`;
