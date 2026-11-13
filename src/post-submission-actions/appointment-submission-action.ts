import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);
import { showSnackbar, translateFrom } from '@openmrs/esm-framework';
import { saveAppointment, saveObs, checkAppointmentConflicts, updateObsComment } from '../api';
import { extractErrorMessagesFromResponse } from '../utils/error-utils';
import { type PostSubmissionAction } from '../types';
import { formEngineAppName } from '../globals';
import { type TOptions } from 'i18next';

/**
 * Configuration for `AppointmentSubmissionAction`, supplied via the form schema's
 * `postSubmissionActions[].config` block.
 *
 * Example form schema snippet:
 * ```json
 * {
 *   "postSubmissionActions": [
 *     {
 *       "actionId": "AppointmentSubmissionAction",
 *       "config": {
 *         "appointmentDateFieldId": "nextAppointmentDate",
 *         "serviceUuid": "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d",
 *         "appointmentKind": "Scheduled",
 *         "appointmentUuidConcept": "<text-concept-uuid-to-store-appointment-id>"
 *       }
 *     }
 *   ]
 * }
 * ```
 */
export interface AppointmentSubmissionConfig {
  /**
   * The `id` of the form field whose value holds the appointment datetime.
   * The field should use `rendering: "appointment"` and be backed by an obs
   * concept so the value is present in the saved encounter obs.
   */
  appointmentDateFieldId: string;
  /**
   * UUID of the OpenMRS appointment service.
   * Fetch available services via `getAppointmentServices()`.
   */
  serviceUuid: string;
  /**
   * Kind of appointment. Common values: "Scheduled", "WalkIn", "Virtual".
   * Defaults to "Scheduled" when omitted.
   */
  appointmentKind?: string;
  /**
   * UUID of a Text concept used to store the created appointment's UUID as an obs.
   * Optional. If configured, the action stores the appointment UUID as a dedicated
   * obs with this concept on first save, and reads it back on edit.
   *
   * If omitted (default), the action stores the appointment UUID as a comment on
   * the appointment date obs — no extra concept required. Edit mode reads the
   * comment to find the existing appointment UUID.
   */
  appointmentUuidConcept?: string;
}

/**
 * Post-submission action that creates (or updates) an OpenMRS appointment after
 * the encounter is saved successfully.
 *
 * How the datetime is resolved:
 * 1. The saved encounter's `obs` array is searched for an entry whose
 *    `formFieldPath` contains `appointmentDateFieldId`.
 * 2. The obs value (stored as UTC "YYYY-MM-DD HH:mm" by the ObsAdapter for
 *    datetime fields) is parsed and used as the `startDateTime`.
 *    If the obs value is date-only ("YYYY-MM-DD"), the current UTC time is appended.
 * 3. `endDateTime` is set to `startDateTime` + 1 hour.
 *
 * How edit mode works:
 * 1. If `appointmentUuidConcept` is configured → looks for an obs with that concept
 *    whose value is the previously-created appointment's UUID.
 * 2. Otherwise → reads the `comment` field on the appointment date obs (where the
 *    UUID was stored on first save).
 * 3. The found UUID is included in the payload so the POST updates the existing
 *    appointment instead of creating a duplicate.
 *
 * Before creating/updating, the action checks for scheduling conflicts via
 * POST /appointments/conflicts. If a `PATIENT_DOUBLE_BOOKING` conflict is found,
 * an error snackbar is shown and no appointment is created.
 *
 * The action is a no-op in `view` and `embedded-view` session modes.
 */
export const AppointmentSubmissionAction: PostSubmissionAction = {
  applyAction: async function ({ patient, encounters, sessionMode }, config: AppointmentSubmissionConfig) {
    const t = (key: string, defaultValue: string, options?: Omit<TOptions, 'ns' | 'defaultValue'>) =>
      translateFrom(formEngineAppName, key, defaultValue, options);

    const isEditing = sessionMode === 'edit';

    // No-op in read-only modes — there is nothing new to schedule.
    if (sessionMode === 'view' || sessionMode === 'embedded-view') {
      return;
    }

    // ── Config validation ─────────────────────────────────────────────────────
    if (!config?.appointmentDateFieldId) {
      throw new Error(
        t(
          'appointmentDateFieldIdNotConfigured',
          'AppointmentSubmissionAction: "appointmentDateFieldId" is not configured.',
        ),
      );
    }
    if (!config?.serviceUuid) {
      throw new Error(
        t('appointmentServiceUuidNotConfigured', 'AppointmentSubmissionAction: "serviceUuid" is not configured.'),
      );
    }

    const encounter = encounters[0];
    if (!encounter) {
      throw new Error(
        t('appointmentNoEncounterData', 'AppointmentSubmissionAction: No encounter data available.'),
      );
    }

    // ── Resolve appointment datetime from saved obs ───────────────────────────
    // The ObsAdapter stores the field path as "rfe-forms-<fieldId>", so we look
    // for any obs whose formFieldPath includes the configured field ID.
    const appointmentObs = encounter.obs?.find((obs) =>
      obs.formFieldPath?.includes(config.appointmentDateFieldId),
    );

    if (!appointmentObs) {
      throw new Error(
        t(
          'appointmentDateObsNotFound',
          'AppointmentSubmissionAction: No obs found for field "{{fieldId}}" in the saved encounter. ' +
            'Ensure the field is not transient and is backed by a concept.',
          { fieldId: config.appointmentDateFieldId },
        ),
      );
    }

    // obs.value is a datetime string ("YYYY-MM-DD HH:mm" in UTC) for a datetime
    // picker backed by an obs concept.
    const rawDateValue = typeof appointmentObs.value === 'string' ? appointmentObs.value : null;

    if (!rawDateValue) {
      throw new Error(
        t(
          'appointmentDateValueInvalid',
          'AppointmentSubmissionAction: The obs value for field "{{fieldId}}" is not a valid datetime string.',
          { fieldId: config.appointmentDateFieldId },
        ),
      );
    }

    // The ObsAdapter formats datetime values as UTC ("YYYY-MM-DD HH:mm"), but if
    // the backing concept is Date type (not DateTime), the server may return only
    // "YYYY-MM-DD" with no time. In that case, append the current time.
    let parsedValue = rawDateValue.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(parsedValue)) {
      const now = new Date();
      const hours = now.getUTCHours().toString().padStart(2, '0');
      const minutes = now.getUTCMinutes().toString().padStart(2, '0');
      parsedValue = `${parsedValue} ${hours}:${minutes}`;
    }

    // Parse as UTC to preserve the correct time.
    const startMoment = dayjs.utc(parsedValue);
    if (!startMoment.isValid()) {
      throw new Error(
        t(
          'appointmentDateValueInvalid',
          'AppointmentSubmissionAction: The obs value for field "{{fieldId}}" is not a valid datetime string.',
          { fieldId: config.appointmentDateFieldId },
        ),
      );
    }

    // startDateTime = the full datetime, endDateTime = start + 1 hour.
    const startDateTime = startMoment.toISOString();
    const endDateTime = startMoment.add(1, 'hour').toISOString();

    // ── Find existing appointment UUID when editing ───────────────────────
    // Two strategies:
    // 1. If appointmentUuidConcept is configured → look for an obs with that concept
    // 2. Otherwise → read the comment on the appointment date obs (where we stored it)
    let existingAppointmentUuid: string | undefined;
    if (isEditing) {
      if (config.appointmentUuidConcept) {
        const uuidObs = encounter.obs?.find(
          (obs) => obs.concept?.uuid === config.appointmentUuidConcept,
        );
        existingAppointmentUuid = typeof uuidObs?.value === 'string' ? uuidObs.value : undefined;
      } else if (appointmentObs?.comment) {
        // UUID was stored as a comment on the appointment date obs
        existingAppointmentUuid = appointmentObs.comment;
      }
    }

    // ── Build & POST appointment payload ──────────────────────────────────────
    // Resolve the current provider from the saved encounter's encounterProviders.
    const providerUuid = encounter.encounterProviders?.[0]?.provider?.uuid;
    const appointmentPayload = {
      uuid: existingAppointmentUuid,
      appointmentKind: config.appointmentKind ?? 'Scheduled',
      serviceUuid: config.serviceUuid,
      startDateTime,
      endDateTime,
      patientUuid: patient.id,
      providers: providerUuid ? [{ uuid: providerUuid }] : undefined,
    };

    const abortController = new AbortController();

    // ── Check for appointment conflicts ──────────────────────────────────────
    // POST the same payload to /appointments/conflicts before creating/updating.
    // A 204 response means no conflict; a 200 with PATIENT_DOUBLE_BOOKING means
    // the patient already has an overlapping appointment.
    try {
      const conflictResponse = await checkAppointmentConflicts(appointmentPayload, abortController);
      const conflictData = conflictResponse?.data;
      if (conflictData && Array.isArray(conflictData.PATIENT_DOUBLE_BOOKING) && conflictData.PATIENT_DOUBLE_BOOKING.length > 0) {
        showSnackbar({
          kind: 'error',
          title: t('appointmentConflict', 'Patient already booked for an appointment at this time'),
          isLowContrast: false,
        });
        return;
      }
    } catch {
      // If the conflict check fails, proceed with the appointment — better to
      // attempt the creation than to block it due to a check endpoint error.
      console.warn('AppointmentSubmissionAction: Conflict check failed, proceeding with appointment');
    }

    try {
      const response = await saveAppointment(appointmentPayload, abortController);
      const createdAppointmentUuid = response?.data?.uuid;

      // ── Save the appointment UUID (enter mode only) ───────────────────────
      // On first creation, persist the appointment UUID so edit mode can find it.
      // Strategy:
      // 1. If appointmentUuidConcept is configured → save as a dedicated obs
      // 2. Otherwise → store as a comment on the appointment date obs
      if (!isEditing && createdAppointmentUuid) {
        if (config.appointmentUuidConcept) {
          try {
            await saveObs(
              {
                person: patient.id,
                concept: config.appointmentUuidConcept,
                value: createdAppointmentUuid,
                encounter: encounter.uuid,
              },
              abortController,
            );
          } catch (obsError) {
            console.warn('AppointmentSubmissionAction: Failed to save appointment UUID obs', obsError);
            showSnackbar({
              kind: 'warning',
              title: t('appointmentCreatedObsWarning', 'Appointment created but UUID not saved'),
              subtitle: t(
                'appointmentCreatedObsWarningDescription',
                'The appointment was scheduled but the appointment ID could not be saved to the encounter. ' +
                  'Editing this encounter may create a duplicate appointment.',
              ),
              isLowContrast: false,
            });
          }
        } else if (appointmentObs?.uuid) {
          try {
            await updateObsComment(appointmentObs.uuid, createdAppointmentUuid, abortController);
          } catch (commentError) {
            console.warn('AppointmentSubmissionAction: Failed to save appointment UUID as comment', commentError);
            showSnackbar({
              kind: 'warning',
              title: t('appointmentCreatedObsWarning', 'Appointment created but UUID not saved'),
              subtitle: t(
                'appointmentCreatedObsWarningDescription',
                'The appointment was scheduled but the appointment ID could not be saved to the encounter. ' +
                  'Editing this encounter may create a duplicate appointment.',
              ),
              isLowContrast: false,
            });
          }
        }
      }

      showSnackbar({
        kind: 'success',
        title: isEditing
          ? t('appointmentUpdated', 'Appointment updated')
          : t('appointmentCreated', 'Appointment scheduled'),
        subtitle: t(
          'appointmentCreatedDescription',
          'The appointment has been successfully scheduled for {{date}}.',
          { date: startMoment.format('YYYY-MM-DD HH:mm') },
        ),
        isLowContrast: true,
      });
    } catch (error) {
      const errorMessages = extractErrorMessagesFromResponse(error);
      showSnackbar({
        title: t('errorCreatingAppointment', 'Error scheduling appointment'),
        subtitle: errorMessages.join(', '),
        kind: 'error',
        isLowContrast: false,
      });
    }
  },
};

export default AppointmentSubmissionAction;
