import React, { useCallback, useEffect, useMemo, useState } from 'react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import { Button, Layer, TimePicker } from '@carbon/react';
import { Close } from '@carbon/react/icons';
import { OpenmrsDatePicker } from '@openmrs/esm-framework';
import { formatDateAsDisplayString } from '../../../utils/common-utils';
import { isEmpty } from '../../../validators/form-validator';
import { isTrue } from '../../../utils/boolean-utils';
import { shouldUseInlineLayout } from '../../../utils/form-helper';
import { useFormProviderContext } from '../../../provider/form-provider';
import { type FormFieldInputProps } from '../../../types';
import FieldLabel from '../../field-label/field-label.component';
import FieldValueView from '../../value/view/field-value-view.component';
import styles from './date.scss';

const DateField: React.FC<FormFieldInputProps> = ({ field, value: dateValue, errors, warnings, setFieldValue }) => {
  const { t } = useTranslation();
  const [time, setTime] = useState('');
  const { layoutType, sessionMode, workspaceLayout } = useFormProviderContext();
  const isInline = useMemo(() => {
    if (['view', 'embedded-view'].includes(sessionMode) || isTrue(field.readonly)) {
      return shouldUseInlineLayout(field.inlineRendering, layoutType, workspaceLayout, sessionMode);
    }
    return false;
  }, [sessionMode, field.readonly, field.inlineRendering, layoutType, workspaceLayout]);

  const onDateChange = useCallback(
    (date: Date) => {
      setTimeIfPresent(date, time);
      setFieldValue(date);
    },
    [setFieldValue, time],
  );

  const handleClear = useCallback(() => {
    setTime('');
    setFieldValue(null);
  }, [setFieldValue]);

  const setTimeIfPresent = useCallback((date: Date, time: string) => {
    if (!isEmpty(time)) {
      const [hours, minutes] = time.split(':').map(Number);
      date.setHours(hours ?? 0, minutes ?? 0);
    }
  }, []);

  const onTimeChange = useCallback(
    (event) => {
      const time = event.target.value;
      setTime(time);
      // TODO: Confirm if a new date should be instantiated when the date picker format is 'timer'
      // If the underlying concept's datatype is 'Time', then the backend expects a time string
      const date = field.datePickerFormat === 'timer' ? new Date() : new Date(dateValue);
      setTimeIfPresent(date, time);
      setFieldValue(date);
    },
    [setFieldValue, setTimeIfPresent, dateValue],
  );

  useEffect(() => {
    if (dateValue) {
      // Handle both Date objects and string values (defaultValue may be
      // serialized to a string during form state propagation)
      const dateObj = dateValue instanceof Date
        ? dateValue
        : typeof dateValue === 'string' && dateValue
          ? new Date(dateValue)
          : null;
      if (dateObj && !isNaN(dateObj.getTime())) {
        const hours = dateObj.getHours() < 10 ? `0${dateObj.getHours()}` : `${dateObj.getHours()}`;
        const minutes = dateObj.getMinutes() < 10 ? `0${dateObj.getMinutes()}` : `${dateObj.getMinutes()}`;
        setTime([hours, minutes].join(':'));
      }
    } else {
      setTime('');
    }
  }, [dateValue]);

  // Prefill the time picker with the current time for appointment fields in
  // enter mode. Runs once on mount.
  useEffect(() => {
    if (
      field.questionOptions.rendering === 'appointment' &&
      field.datePickerFormat === 'both' &&
      sessionMode === 'enter' &&
      !time
    ) {
      const now = new Date();
      const hours = now.getHours() < 10 ? `0${now.getHours()}` : `${now.getHours()}`;
      const minutes = now.getMinutes() < 10 ? `0${now.getMinutes()}` : `${now.getMinutes()}`;
      const currentTime = `${hours}:${minutes}`;
      setTime(currentTime);
      // If a date already exists, update it with the current time; otherwise
      // create a new Date at the current moment.
      const baseDate = dateValue instanceof Date
        ? new Date(dateValue)
        : typeof dateValue === 'string' && dateValue
          ? new Date(dateValue)
          : new Date();
      setTimeIfPresent(baseDate, currentTime);
      setFieldValue(baseDate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const timePickerLabel = useMemo(
    () =>
      field.datePickerFormat === 'timer' ? (
        <FieldLabel field={field} />
      ) : (
        <FieldLabel field={field} customLabel={t('time', 'Time')} />
      ),
    [field.datePickerFormat, field.label, t],
  );

  return sessionMode == 'view' || sessionMode == 'embedded-view' || isTrue(field.readonly) ? (
    <FieldValueView
      label={t(field.label)}
      value={dateValue instanceof Date ? formatDateAsDisplayString(field, dateValue) : dateValue}
      conceptName={field.meta?.concept?.display}
      isInline={isInline}
    />
  ) : (
    !field.isHidden && (
      <div className={styles.datetime}>
        {(field.datePickerFormat === 'calendar' || field.datePickerFormat === 'both') && (
          <div className={styles.datePickerSpacing}>
            <Layer>
              <OpenmrsDatePicker
                id={field.id}
                onChange={onDateChange}
                labelText={
                  <span className={styles.datePickerLabel}>
                    <FieldLabel field={field} />
                  </span>
                }
                isDisabled={field.isDisabled}
                isReadOnly={isTrue(field.readonly)}
                isRequired={field.isRequired ?? false}
                isInvalid={errors.length > 0}
                invalidText={errors[0]?.message}
                value={dateValue}
              />
            </Layer>
            {warnings.length > 0 ? <div className={styles.datePickerWarn}>{warnings[0]?.message}</div> : null}
          </div>
        )}

        {field.datePickerFormat === 'both' || field.datePickerFormat === 'timer' ? (
          <div>
            <Layer>
              <TimePicker
                className={classNames(styles.boldedLabel, styles.timeInput)}
                id={field.id}
                labelText={timePickerLabel}
                placeholder="HH:MM"
                pattern="(1[012]|[1-9]):[0-5][0-9]$"
                type="time"
                disabled={field.datePickerFormat === 'timer' ? field.isDisabled : !dateValue ? true : false}
                invalid={errors.length > 0}
                invalidText={errors[0]?.message}
                readOnly={isTrue(field.readonly)}
                warning={warnings.length > 0}
                warningText={warnings[0]?.message}
                value={
                  time
                    ? time
                    : dateValue instanceof Date
                    ? dateValue.toLocaleDateString(window.navigator.language)
                    : dateValue
                }
                onChange={onTimeChange}
              />
            </Layer>
          </div>
        ) : null}

        {dateValue && !field.isDisabled && !isTrue(field.readonly) && (
          <div className={styles.clearButtonContainer}>
            <Button
              hasIconOnly
              renderIcon={(props) => <Close size={16} {...props} />}
              iconDescription={t('clear', 'Clear')}
              tooltipPosition="bottom"
              kind="ghost"
              size="md"
              onClick={handleClear}
            />
          </div>
        )}
      </div>
    )
  );
};

export default DateField;
