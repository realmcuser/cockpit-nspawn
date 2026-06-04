import React, { useState, useEffect } from 'react';
import {
    Button,
    FormGroup,
    FormSelect,
    FormSelectOption,
    HelperText,
    HelperTextItem,
    InputGroup,
    InputGroupItem,
    Label,
    LabelGroup,
    TextInput,
} from '@patternfly/react-core';
import { PlusIcon } from '@patternfly/react-icons';
import cockpit from 'cockpit';

const { gettext: _ } = cockpit;

const CATEGORIES = [
    { key: 'serial', label: 'Serial',  dir: '/dev', patterns: ['ttyS[0-9]*', 'ttyUSB*', 'ttyACM*'] },
    { key: 'video',  label: 'Video',   dir: '/dev', patterns: ['video*'] },
    { key: 'sound',  label: 'Sound',   dir: '/dev/snd', patterns: ['pcm*', 'control*', 'timer', 'seq'] },
    { key: 'dri',    label: 'GPU/DRI', dir: '/dev/dri', patterns: ['card*', 'renderD*'] },
];

async function fetchCategory(cat) {
    const found = [];
    for (const pat of cat.patterns) {
        try {
            const out = await cockpit.spawn(
                ['find', cat.dir, '-maxdepth', '1', '-name', pat],
                { superuser: 'try', err: 'ignore' }
            );
            found.push(...out.trim().split('\n').filter(Boolean));
        } catch (_e) {}
    }
    return found.sort();
}

export function DeviceBindingEditor({ bindings, onChange, isDisabled }) {
    const [categories, setCategories] = useState([]);
    const [selected, setSelected]     = useState('');
    const [freeText, setFreeText]     = useState('');

    useEffect(() => {
        Promise.all(CATEGORIES.map(async cat => ({
            label: cat.label,
            devices: await fetchCategory(cat),
        }))).then(cats => {
            const nonempty = cats.filter(c => c.devices.length > 0);
            setCategories(nonempty);
            if (nonempty.length > 0) setSelected(nonempty[0].devices[0]);
        });
    }, []);

    const add = (path) => {
        const p = path.trim();
        if (!p || bindings.includes(p)) return;
        onChange([...bindings, p]);
    };

    const remove = (path) => onChange(bindings.filter(b => b !== path));

    return (
        <FormGroup label={_("Device bindings")} fieldId="dev-bindings">
            {bindings.length > 0 && (
                <LabelGroup style={{ marginBottom: '0.5rem' }}>
                    {bindings.map(dev => (
                        <Label key={dev} onClose={isDisabled ? undefined : () => remove(dev)}>
                            {dev}
                        </Label>
                    ))}
                </LabelGroup>
            )}
            {!isDisabled && (
                <>
                    <InputGroup style={{ marginBottom: '0.5rem' }}>
                        <InputGroupItem isFill>
                            <FormSelect
                                id="dev-select"
                                value={selected}
                                onChange={(_e, v) => setSelected(v)}
                                isDisabled={categories.length === 0}
                                aria-label={_("Select host device")}
                            >
                                {categories.length === 0
                                    ? <FormSelectOption value="" label={_("No devices found on host")} />
                                    : categories.map(cat => (
                                        <optgroup key={cat.label} label={cat.label}>
                                            {cat.devices.map(d => (
                                                <FormSelectOption key={d} value={d} label={d} />
                                            ))}
                                        </optgroup>
                                    ))
                                }
                            </FormSelect>
                        </InputGroupItem>
                        <InputGroupItem>
                            <Button
                                variant="secondary"
                                icon={<PlusIcon />}
                                onClick={() => add(selected)}
                                isDisabled={!selected}
                                aria-label={_("Add selected device")}
                            >
                                {_("Add")}
                            </Button>
                        </InputGroupItem>
                    </InputGroup>
                    <InputGroup>
                        <InputGroupItem isFill>
                            <TextInput
                                id="dev-freetext"
                                placeholder="/dev/..."
                                value={freeText}
                                onChange={(_e, v) => setFreeText(v)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') { add(freeText); setFreeText(''); }
                                }}
                                aria-label={_("Custom device path")}
                            />
                        </InputGroupItem>
                        <InputGroupItem>
                            <Button
                                variant="secondary"
                                icon={<PlusIcon />}
                                onClick={() => { add(freeText); setFreeText(''); }}
                                isDisabled={!freeText.trim()}
                                aria-label={_("Add custom device path")}
                            >
                                {_("Add")}
                            </Button>
                        </InputGroupItem>
                    </InputGroup>
                </>
            )}
            <HelperText>
                <HelperTextItem>
                    {_("Devices are bound read-write into the container. Requires restart to take effect.")}
                </HelperTextItem>
            </HelperText>
        </FormGroup>
    );
}
