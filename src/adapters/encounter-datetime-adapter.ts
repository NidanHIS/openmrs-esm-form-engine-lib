import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { formatDate, type OpenmrsResource } from '@openmrs/esm-framework';
import { type FormContextProps } from '../provider/form-provider';
import {
  type FormField,
  type FormProcessorContextProps,
  type FormFieldValueAdapter,
  type ValueAndDisplay,
} from '../types';
import { gracefullySetSubmission } from '../utils/common-utils';

dayjs.extend(utc);

export const EncounterDatetimeAdapter: FormFieldValueAdapter = {
  transformFieldValue: function (field: FormField, value: any, context: FormContextProps) {
    // Convert local Date to a UTC string so the server stores the correct UTC time.
    // Without this, the local time is sent as-is and the server treats it as UTC,
    // causing an offset equal to the user's timezone.
    const utcValue = value instanceof Date ? dayjs(value).utc().format('YYYY-MM-DD HH:mm:ss') : value;
    gracefullySetSubmission(field, utcValue, null);
  },
  
  getInitialValue: function (field: FormField, sourceObject: OpenmrsResource, context: FormProcessorContextProps) {
    if (sourceObject?.encounterDatetime) {
      // Parse the UTC string from the server and convert to local time for display
      return dayjs.utc(sourceObject.encounterDatetime as string).local().toDate();
    }
    return context.sessionDate;
  },
  getPreviousValue: function (
    field: FormField,
    sourceObject: OpenmrsResource,
    context: FormProcessorContextProps,
  ): ValueAndDisplay {
    if (sourceObject?.encounterDatetime) {
      // Parse as UTC and convert to local time for display
      const date = dayjs.utc(sourceObject.encounterDatetime as string).local().toDate();
      return {
        value: date,
        display: this.getDisplayValue(field, date),
      };
    }
    return null;
  },
  getDisplayValue: function (field: FormField, value: Date) {
    return formatDate(value);
  },
  tearDown: function (): void {
    return;
  },
};
