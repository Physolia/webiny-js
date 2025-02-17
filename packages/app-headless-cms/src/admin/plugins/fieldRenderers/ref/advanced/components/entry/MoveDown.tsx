import React from "react";
import { ButtonLink } from "./elements/ButtonLink";
import { ReactComponent as MoveDownIcon } from "./assets/move-down.svg";
import { Tooltip } from "@webiny/ui/Tooltip";

interface Props {
    onClick: (ev: React.MouseEvent) => void;
    className?: string;
}

export const MoveDown: React.VFC<Props> = ({ onClick, className }) => {
    return (
        <ButtonLink className={"has-tooltip " + className} onClick={onClick} maxWidth={"100px"}>
            <Tooltip content={"Shift+Click to move to bottom"} placement={"top"}>
                <MoveDownIcon /> <span>Move Down</span>
            </Tooltip>
        </ButtonLink>
    );
};
