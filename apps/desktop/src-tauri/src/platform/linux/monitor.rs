use crate::domain::{MonitorAtCursor, ScreenVisibleArea};
use gtk::gdk;
use gtk::prelude::*;

pub fn get_monitor_at_cursor() -> Option<MonitorAtCursor> {
    let display = gdk::Display::default()?;
    let seat = display.default_seat()?;
    let pointer = seat.pointer()?;

    let (_, x, y) = pointer.position();

    let monitor = display.monitor_at_point(x, y)?;
    let geometry = monitor.geometry();
    let workarea = monitor.workarea();
    let scale_factor = monitor.scale_factor() as f64;

    // GTK workarea returns device pixels but we need logical pixels for UI positioning
    // on HiDPI displays. Only scale workarea coordinates.
    let workarea_logical_x = workarea.x() as f64 / scale_factor;
    let workarea_logical_y = workarea.y() as f64 / scale_factor;
    let workarea_logical_width = workarea.width() as f64 / scale_factor;
    let workarea_logical_height = workarea.height() as f64 / scale_factor;

    Some(MonitorAtCursor {
        // Scale geometry to logical pixels to match workarea
        x: geometry.x() as f64 / scale_factor,
        y: geometry.y() as f64 / scale_factor,
        width: geometry.width() as f64 / scale_factor,
        height: geometry.height() as f64 / scale_factor,
        // Use logical pixels from workarea for visible area calculations
        visible_x: workarea_logical_x,
        visible_y: workarea_logical_y,
        visible_width: workarea_logical_width,
        visible_height: workarea_logical_height,
        scale_factor,
        cursor_x: x as f64,
        cursor_y: y as f64,
    })
}

pub fn get_bottom_pill_offset() -> f64 {
    8.0
}

pub fn get_screen_visible_area() -> ScreenVisibleArea {
    let Some(display) = gdk::Display::default() else {
        return ScreenVisibleArea::default();
    };

    let Some(seat) = display.default_seat() else {
        return ScreenVisibleArea::default();
    };

    let Some(pointer) = seat.pointer() else {
        return ScreenVisibleArea::default();
    };

    let (_, x, y) = pointer.position();

    let Some(monitor) = display.monitor_at_point(x, y) else {
        return ScreenVisibleArea::default();
    };

    let geometry = monitor.geometry();
    let workarea = monitor.workarea();
    let scale_factor = monitor.scale_factor() as f64;

    // Scale insets to logical pixels for HiDPI displays
    ScreenVisibleArea {
        top_inset: (workarea.y() - geometry.y()) as f64 / scale_factor,
        bottom_inset: ((geometry.y() + geometry.height()) - (workarea.y() + workarea.height()))
            as f64 / scale_factor,
        left_inset: (workarea.x() - geometry.x()) as f64 / scale_factor,
        right_inset: ((geometry.x() + geometry.width()) - (workarea.x() + workarea.width())) as f64 / scale_factor,
    }
}
