'use client';

import { useLayoutEffect, useState, type RefObject } from 'react';

import { STAGE_MIN_HEIGHT, STAGE_PADDING, STAGE_VIEWPORT_INSET, type StageSize } from '../lib/scene';

/** The map's drawing area: width from the stage element, height from the window. */
export function useStageSize(stageRef: RefObject<HTMLDivElement | null>): StageSize | null {
    const [stage, setStage] = useState<StageSize | null>(null);
    useLayoutEffect(() => {
        const element = stageRef.current;
        if (!element) return;

        // Width from the element; height from the window (the element's own height follows the view).
        const measure = () => {
            const width = Math.floor(element.clientWidth) - STAGE_PADDING * 2;
            const height = Math.max(STAGE_MIN_HEIGHT, window.innerHeight - STAGE_VIEWPORT_INSET) - STAGE_PADDING * 2;
            setStage(current => (current?.width === width && current.height === height ? current : { width, height }));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        window.addEventListener('resize', measure);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', measure);
        };
    }, [stageRef]);
    return stage;
}
