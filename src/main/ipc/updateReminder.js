function registerUpdateReminderIpc({ handle, getUpdateReminder }) {
    handle('update-reminder-check', async () => {
        const updateReminder = getUpdateReminder();
        if (!updateReminder) return { error: '提醒服务未初始化' };
        try {
            return await updateReminder.checkNow();
        } catch (error) {
            console.error('[UpdateReminder] 手动检查失败:', error);
            return { error: error.message };
        }
    });

    handle('update-reminder-list', async () => {
        const updateReminder = getUpdateReminder();
        if (!updateReminder) return { reminders: [], lastCheckTime: 0 };
        return updateReminder.getReminders();
    });

    handle('update-reminder-mark-read', async (event, animeId, source) => {
        const updateReminder = getUpdateReminder();
        if (!updateReminder) return { success: false };
        updateReminder.markAsRead(animeId, source);
        return { success: true };
    });

    handle('update-reminder-clear', async () => {
        const updateReminder = getUpdateReminder();
        if (!updateReminder) return { success: false };
        updateReminder.clear();
        return { success: true };
    });

    handle('update-reminder-configure', async (event, options = {}) => {
        const updateReminder = getUpdateReminder();
        if (!updateReminder) return { success: false };
        updateReminder.configure(options);
        return { success: true };
    });
}

module.exports = { registerUpdateReminderIpc };
