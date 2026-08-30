import React, { useEffect, useMemo, useState } from 'react';
import { DropdownSkeleton, FilterableMultiSelect, Layer, Tag } from '@carbon/react';
import { useTranslation } from 'react-i18next';
import { useWatch } from 'react-hook-form';
import { type OpenmrsResource } from '@openmrs/esm-framework';
import { getControlTemplate } from '../../../registry/inbuilt-components/control-templates';
import { getRegisteredDataSource } from '../../../registry/registry';
import { isTrue } from '../../../utils/boolean-utils';
import { isViewMode } from '../../../utils/common-utils';
import { shouldUseInlineLayout } from '../../../utils/form-helper';
import { type DataSource, type FormFieldInputProps } from '../../../types';
import { useFormProviderContext } from '../../../provider/form-provider';
import { ValueEmpty } from '../../value/value.component';
import FieldLabel from '../../field-label/field-label.component';
import FieldValueView from '../../value/view/field-value-view.component';
import styles from './multi-select.scss';

const MultiProviderSelect: React.FC<FormFieldInputProps> = ({
  field,
  value = [],
  errors,
  warnings,
  setFieldValue,
}) => {
  const { t } = useTranslation();
  const [items, setItems] = useState<OpenmrsResource[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [dataSource, setDataSource] = useState<DataSource<OpenmrsResource> | null>(null);
  // itemsLoadedKey forces FilterableMultiSelect to remount once items are available
  // so that initialSelectedItems resolves correctly from the loaded list.
  const [itemsLoadedKey, setItemsLoadedKey] = useState(0);

  const {
    layoutType,
    sessionMode,
    workspaceLayout,
    methods: { control },
  } = useFormProviderContext();

  const isInline = useMemo(() => {
    if (isViewMode(sessionMode) || isTrue(field.readonly)) {
      return shouldUseInlineLayout(field.inlineRendering, layoutType, workspaceLayout, sessionMode);
    }
    return false;
  }, [sessionMode, field.readonly, field.inlineRendering, layoutType, workspaceLayout]);

  // Resolve datasource from field options or control template
  useEffect(() => {
    const dsName = field.questionOptions?.datasource?.name;
    getRegisteredDataSource(dsName ? dsName : field.questionOptions.rendering).then((ds) => setDataSource(ds));
  }, [field.questionOptions?.datasource]);

  // Preload all providers once datasource is ready
  useEffect(() => {
    if (!dataSource) return;
    let ignore = false;
    setIsLoading(true);

    const config =
      field.questionOptions?.datasource?.config ??
      getControlTemplate(field.questionOptions.rendering)?.datasource?.config;

    dataSource
      .fetchData(null, config)
      .then((dataItems) => {
        if (!ignore) {
          setItems(dataItems.map(dataSource.toUuidAndDisplay));
          setIsLoading(false);
          // Bump key so FilterableMultiSelect remounts with resolved initialSelectedItems
          setItemsLoadedKey((k) => k + 1);
        }
      })
      .catch((err) => {
        if (!ignore) {
          console.error(err);
          setIsLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [dataSource]);

  // Fetch selected providers in edit mode that are missing from the preloaded list
  useEffect(() => {
    if (!dataSource || !value?.length || sessionMode === 'enter') return;
    let ignore = false;

    const missingUuids = value.filter((uuid) => !items.some((item) => item.uuid === uuid));

    if (missingUuids.length > 0) {
      Promise.all(
        missingUuids.map((uuid) =>
          dataSource.fetchSingleItem(uuid).catch((err) => {
            console.error(`Failed to fetch provider ${uuid}:`, err);
            return null;
          }),
        ),
      ).then((fetchedItems) => {
        if (ignore) return;
        const validItems = fetchedItems
          .filter(Boolean)
          .map((item) => dataSource.toUuidAndDisplay(item));

        if (validItems.length > 0) {
          setItems((prevItems) => {
            const newItems = [...prevItems];
            validItems.forEach((mappedItem) => {
              if (!newItems.some((i) => i.uuid === mappedItem.uuid)) {
                newItems.push(mappedItem);
              }
            });
            return newItems;
          });
          setItemsLoadedKey((k) => k + 1);
        }
      });
    }

    return () => {
      ignore = true;
    };
  }, [dataSource, value, items.length, sessionMode]);

  // Items currently selected according to form state
  const selectedItems = useMemo(
    () => items.filter((item) => Array.isArray(value) && value.includes(item.uuid)),
    [items, value],
  );

  if (isViewMode(sessionMode) || isTrue(field.readonly)) {
    return (
      <FieldValueView
        label={t(field.label)}
        value={selectedItems.map((item) => item.display).join(', ') || value}
        conceptName={field.meta?.concept?.display}
        isInline={isInline}
      />
    );
  }

  if (isLoading) {
    return <DropdownSkeleton />;
  }

  return !field.isHidden ? (
    <>
      <div className={styles.boldedLabel}>
        <Layer>
          <FilterableMultiSelect
            // Re-keyed after items load so initialSelectedItems is applied correctly
            key={itemsLoadedKey}
            id={field.id}
            titleText={<FieldLabel field={field} />}
            items={items}
            itemToString={(item) => item?.display ?? ''}
            initialSelectedItems={selectedItems}
            onChange={({ selectedItems: newSelected }) => {
              setFieldValue(newSelected.map((item) => item.uuid));
            }}
            placeholder={`${t('search', 'Search')}...`}
            disabled={field.isDisabled}
            readOnly={isTrue(field.readonly)}
            invalid={errors.length > 0}
            invalidText={errors[0]?.message}
            warn={warnings.length > 0}
            warnText={warnings[0]?.message}
          />
        </Layer>
      </div>
      <div className={styles.selectionDisplay}>
        {selectedItems.length ? (
          <div className={styles.tagContainer}>
            {selectedItems.map((item) => (
              <Tag key={item.uuid} type="cool-gray">
                {item.display}
              </Tag>
            ))}
          </div>
        ) : (
          <ValueEmpty />
        )}
      </div>
    </>
  ) : null;
};

export default MultiProviderSelect;
