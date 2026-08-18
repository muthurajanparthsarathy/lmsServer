const cron = require('node-cron');
const Feedback = require('../models/FeedbackModal');

/**
 * Cron job to automatically sync feedback status based on dates
 * Runs every minute to ensure timely updates
 */
const syncFeedbackStatus = async () => {
    try {
        
        const result = await Feedback.syncAllStatuses();
        
        
        return result;
    } catch (error) {
        console.error('❌ Error syncing feedback status:', error);
        throw error;
    }
};

// Schedule the cron job to run every minute
// You can adjust the schedule as needed
const startStatusSyncCron = () => {
    // Run every minute
    cron.schedule('* * * * *', async () => {
        try {
            await syncFeedbackStatus();
        } catch (error) {
            console.error('Cron job error:', error);
        }
    });
    
};

// For immediate execution (useful for testing or one-time sync)
const runStatusSyncOnce = async () => {
    return await syncFeedbackStatus();
};

module.exports = {
    syncFeedbackStatus,
    startStatusSyncCron,
    runStatusSyncOnce
};