import { CapabilityError } from "./errors.js";

export const FIELD_ALIASES = Object.freeze({
  leadId: Object.freeze([
    "local_services_lead.id",
    "localServicesLead.id"
  ]),
  leadType: Object.freeze([
    "local_services_lead.lead_type",
    "localServicesLead.leadType"
  ]),
  participantType: Object.freeze([
    "local_services_lead_conversation.participant_type",
    "localServicesLeadConversation.participantType"
  ]),
  conversationChannel: Object.freeze([
    "local_services_lead_conversation.conversation_channel",
    "localServicesLeadConversation.conversationChannel"
  ]),
  callDurationMillis: Object.freeze([
    "local_services_lead_conversation.phone_call_details.call_duration_millis",
    "localServicesLeadConversation.phoneCallDetails.callDurationMillis"
  ]),
  eventDateTime: Object.freeze([
    "local_services_lead_conversation.event_date_time",
    "localServicesLeadConversation.eventDateTime"
  ]),
  messageText: Object.freeze([
    "local_services_lead_conversation.message_details.text",
    "localServicesLeadConversation.messageDetails.text"
  ])
});

export function resolveColumns(columns, { requireMessageText = false } = {}) {
  if (!Array.isArray(columns) || !columns.every((value) => typeof value === "string")) {
    throw new CapabilityError("Response columns must be an array of strings.");
  }

  const resolved = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const matches = columns.flatMap((column, index) => aliases.includes(column) ? [index] : []);
    if (matches.length > 1) {
      throw new CapabilityError(`Multiple columns resolve to ${field}.`);
    }
    if (matches.length === 0 && (field !== "messageText" || requireMessageText)) {
      throw new CapabilityError(`Required field ${field} is unavailable.`);
    }
    resolved[field] = matches.length === 1 ? matches[0] : null;
  }
  return resolved;
}
