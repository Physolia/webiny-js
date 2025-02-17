import React, { useEffect, useState } from "react";
import { Input } from "@webiny/ui/Input";
import { useVariable } from "~/hooks/useVariable";
import { makeComposable } from "@webiny/react-composition";

interface TextVariableInputProps {
    variableId: string;
}

const TextVariableInput = makeComposable<TextVariableInputProps>(
    "TextVariableInput",
    ({ variableId }) => {
        const { value, onChange, onBlur } = useVariable(variableId);
        const [localValue, setLocalValue] = useState(value);

        useEffect(() => {
            if (localValue !== value) {
                setLocalValue(value);
            }
        }, [value]);

        return (
            <Input
                value={localValue}
                onChange={value => {
                    onChange(value);
                    setLocalValue(value);
                }}
                onBlur={onBlur}
            />
        );
    }
);

export default TextVariableInput;
